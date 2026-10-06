/* Automated checks that run without Upstox credentials, against the test double
   in mock-upstox.js. Real-API checks are in scripts/check-upstox.js. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '../server/marketData/providers/upstoxProto.js';
import { startMock, encode, KEYS } from './mock-upstox.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, failed = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
const get = async (port, p, headers = AUTH) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers }); return { status: r.status, headers: r.headers, body: await r.clone().json().catch(() => null), text: await r.text() }; };
function bullsy(port, mockPort, env = {}) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, BULLSY_SKIP_ENV_FILE: '1', PORT: String(port), UPSTOX_API_BASE: `http://127.0.0.1:${mockPort}`,
    UPSTOX_INSTRUMENTS_URLS: `http://127.0.0.1:${mockPort}/instruments.json`, UPSTOX_ACCESS_TOKEN: 'test-token', BULLSY_POLL_INTERVAL_MS: '2000', ADMIN_PASSWORD: 'pw', BULLSY_DATA_DELAY_DAYS: '0', FRONTEND_ORIGIN: 'https://bullsy.example', ...env } });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  return { stop: () => new Promise(r => { child.on('exit', r); child.kill(); }), logs: () => logs };
}

/* 1. protobuf reader */
{
  const msg = { type: 'live_feed', currentTs: 1740729566039, feeds: { 'NSE_INDEX|Nifty 50': { fullFeed: { indexFF: { ltpc: { ltp: 25165.35, ltt: 1740729552723, ltq: 0, cp: 24960.1 },
    marketOHLC: { ohlc: [{ interval: '1d', open: 25000, high: 25200.5, low: 24950, close: 25165.35, vol: 0, ts: 1740681000000 }] } } } } } };
  const back = decode(new Uint8Array(encode(msg))), f = back.feeds['NSE_INDEX|Nifty 50'].fullFeed.indexFF;
  ok(back.type === 'live_feed' && back.currentTs === 1740729566039 && f.ltpc.ltp === 25165.35 && f.ltpc.cp === 24960.1 && f.marketOHLC.ohlc[0].high === 25200.5, 'protobuf feed message decodes exactly');
  const info = decode(new Uint8Array(encode({ type: 'market_info', marketInfo: { segmentStatus: { NSE_INDEX: 'NORMAL_OPEN', BSE_INDEX: 'NORMAL_CLOSE' } } })));
  ok(info.marketInfo.segmentStatus.NSE_INDEX === 'NORMAL_OPEN' && info.marketInfo.segmentStatus.BSE_INDEX === 'NORMAL_CLOSE', 'protobuf market status decodes');
}

/* 2. live path: WebSocket, quotes, history, SSE */
{
  const mock = await startMock({ port: 4801 }), app = bullsy(4701, 4801); await sleep(3500);
  const q = (await get(4701, '/admin/status.json')).body, ids = Object.keys(KEYS);
  ok(ids.every(id => q.quotes[id]?.price > 0), 'all 8 indices return a quote');
  ok(ids.every(id => q.quotes[id].status === 'LIVE'), 'quotes are LIVE when the provider reports the market open with fresh ticks', JSON.stringify(ids.map(id => q.quotes[id].status)));
  ok(q.market.feed.transport === 'websocket' && q.market.feed.streaming, 'WebSocket feed is the transport');
  const n = q.quotes.NIFTY50; ok(Math.abs(n.change - (n.price - n.prevClose)) < 1e-9 && Math.abs(n.changePct - (n.price - n.prevClose) / n.prevClose * 100) < 1e-9, 'change and change % come from price and previous close');
  ok(ids.every(id => q.quotes[id].verified), 'all 8 instrument keys verified');
  for (const range of ['1D', '1W', '1M', '3M', '6M', '1Y', 'REPLAY']) { const h = (await get(4701, `/api/market/history/NIFTYIT?range=${range}`)).body; ok(h.candles?.length > 1 && h.candles.every((c, i, a) => !i || c.t > a[i - 1].t), `history ${range} returns ordered candles (${h.candles?.length})`); }
  ok((await get(4701, '/api/market/history/NOPE?range=1M')).status === 400, 'unknown index is rejected');
  /* SSE delivers changing genuine values */
  const seen = []; const ctl = new AbortController();
  fetch('http://127.0.0.1:4701/api/market/stream', { signal: ctl.signal }).then(async r => { const dec = new TextDecoder(); for await (const chunk of r.body) for (const line of dec.decode(chunk).split('\n')) if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6)).quotes.NIFTY50.price); }).catch(() => {});
  await sleep(4500); ctl.abort();
  ok(seen.length >= 3 && new Set(seen).size > 1, `stream pushes updates to the browser (${seen.length} messages)`);
  const calls = mock.state.quoteCalls; await sleep(3000);
  ok(mock.state.quoteCalls === calls, 'no polling while the WebSocket is delivering');
  let pub = ''; for (const p of ['/api/market/config', '/api/market/status', '/api/market/quotes', '/api/market/instruments', '/api/health']) { const r = await get(4701, p, {}); ok(r.status === 200, 'public endpoint ' + p); pub += r.text; }
  ok(!/test-token|client_secret|NSE_INDEX\|/.test(pub), 'public API exposes no token, secret or provider internals');
  ok((await get(4701, '/admin', {})).status === 401 && (await get(4701, '/admin/status.json', {})).status === 401, 'admin pages need a sign-in');
  ok((await get(4701, '/admin', { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') })).status === 401, 'admin rejects a wrong password');
  const adm = await get(4701, '/admin'); ok(adm.status === 200 && /Upstox connection: <span class="ok">CONNECTED/.test(adm.text) && (adm.text.match(/class="s LIVE"/g) || []).length === 8, 'admin page shows CONNECTED and 8 LIVE indices');
  ok(!adm.text.includes('test-token'), 'admin page does not print the token');
  ok((await get(4701, '/api/market/quotes', { Origin: 'https://evil.example' })).status === 403, 'another website cannot call the API');
  const fe = await get(4701, '/api/market/quotes', { Origin: 'https://bullsy.example' }); ok(fe.status === 200 && fe.headers.get('access-control-allow-origin') === 'https://bullsy.example', 'the configured frontend site can call the API');
  const bad = await fetch('http://127.0.0.1:4701/admin/token', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&csrf=nope', redirect: 'manual' }); ok(bad.status === 403, 'token form rejects a forged request');
  await app.stop(); await mock.close();
}

/* 3. polling fallback, one index missing, market closed */
{
  const mock = await startMock({ port: 4802, stream: false, missing: ['NIFTYPHARMA'], segment: 'NORMAL_CLOSE' }), app = bullsy(4702, 4802); await sleep(3500);
  const q = (await get(4702, '/admin/status.json')).body;
  ok(q.market.feed.transport === 'polling' || q.quotes.NIFTY50.source === 'rest', 'falls back to polling when the WebSocket is unavailable');
  ok(q.quotes.NIFTYPHARMA.status === 'UNAVAILABLE' && q.quotes.NIFTYPHARMA.price === null && q.quotes.NIFTYIT.price > 0, 'a missing index is UNAVAILABLE with no value; the others still show');
  const c1 = mock.state.quoteCalls; await sleep(6500); const perSec = (mock.state.quoteCalls - c1) / 6.5;
  ok(perSec <= 0.6, `polling is rate-controlled (${perSec.toFixed(2)} requests/s)`);
  await app.stop(); await mock.close();
}

/* 4. expired token: no fake data, last genuine close, clear error */
{
  const mock = await startMock({ port: 4803 }), app = bullsy(4703, 4803, { UPSTOX_ACCESS_TOKEN: 'expired' }); await sleep(4500);
  const q = (await get(4703, '/admin/status.json')).body, n = q.quotes.NIFTY50;
  ok(q.market.feed.authError && /token/i.test(q.market.feed.error), 'expired token is reported as an auth error');
  ok(n.source === 'daily-candle' && n.status !== 'LIVE', `with no live access the last genuine daily close is shown, never LIVE (${n.status})`);
  ok(/access token/i.test(app.logs()), 'developer log explains the token problem');
  const pubq = (await get(4703, '/api/market/quotes', {})).text, adm = (await get(4703, '/admin')).text;
  ok(!/token|UDAPI|upstox/i.test(pubq), 'players never see token or provider error text');
  ok(/DISCONNECTED/.test(adm) && /Last error/.test(adm), 'admin page shows DISCONNECTED with the reason');
  await app.stop(); await mock.close();
}

/* 5. one-day-delayed mode */
{
  const mock = await startMock({ port: 4804 }), app = bullsy(4704, 4804, { BULLSY_DATA_DELAY_DAYS: '1' }); await sleep(4000);
  const q = (await get(4704, '/admin/status.json')).body, h = (await get(4704, '/api/market/history/NIFTY50?range=1M')).body;
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  ok(Object.values(q.quotes).every(v => v.status === 'DELAYED') && q.market.label === 'DELAYED', 'delayed mode labels every index DELAYED');
  ok(new Date(q.quotes.NIFTY50.ts + 19800000).toISOString().slice(0, 10) < today && q.quotes.NIFTY50.price === h.candles.at(-1).c, 'delayed quote is the last completed session close');
  ok(mock.state.quoteCalls === 0 && !mock.state.subscribed, 'delayed mode never requests real-time data');
  const app2 = bullsy(4714, 4804, { BULLSY_DATA_DELAY_DAYS: '1', UPSTOX_ACCESS_TOKEN: '' }); await sleep(4000);
  const q2 = (await get(4714, '/api/market/quotes', {})).body; ok(Object.values(q2.quotes).every(v => v.status === 'DELAYED' && v.price > 0), 'delayed mode works with no Upstox token at all');
  await app2.stop();
  await app.stop(); await mock.close();
}

/* 6. upstream down */
{
  const app = bullsy(4705, 4899); await sleep(3000);
  const q = (await get(4705, '/admin/status.json')).body, h = await get(4705, '/api/market/history/NIFTY50?range=1M');
  ok(Object.values(q.quotes).every(v => v.status === 'UNAVAILABLE' && v.price === null), 'provider unreachable: every index UNAVAILABLE, no invented values');
  ok(h.status === 502 && /unavailable/i.test(h.body.error), 'history request fails cleanly');
  ok((await get(4705, '/', {})).status === 200 && (await get(4705, '/api/health', {})).body.ok === true, 'site and health check still respond');
  await app.stop();
}

/* 7. no random or generated prices in the market-data code */
{
  const files = ['server/index.js', 'server/config.js', 'server/marketData/service.js', 'server/marketData/providers/upstox.js', 'server/marketData/providers/upstoxProto.js', 'server/marketData/marketHours.js', 'public/js/market.js'];
  const hits = files.filter(f => fs.existsSync(path.join(root, f)) && /Math\.random|randn\(|simulate|mock/i.test(fs.readFileSync(path.join(root, f), 'utf8')));
  ok(hits.length === 0, 'no Math.random / simulation / mock code in the market-data layer', hits.join(', '));
  const pub = fs.readdirSync(path.join(root, 'public/js')).map(f => fs.readFileSync(path.join(root, 'public/js', f), 'utf8')).join('\n') + fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  ok(!/UPSTOX_|ANTHROPIC_API_KEY|access_token|client_secret/i.test(pub), 'no credentials or secret names in frontend files');
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
