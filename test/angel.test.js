/* Angel One provider checks, against the test double in mock-angel.js (no account, no network). */
import { spawn } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { totp } from '../server/marketData/providers/totp.js';
import { AngelOneProvider } from '../server/marketData/providers/angelone.js';
import { startAngelMock, TOKENS } from './mock-angel.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failed = 0; const ok = (c, n, x = '') => { c ? pass++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const AUTH = { Authorization: 'Basic ' + Buffer.from('a:pw').toString('base64') }, CREDS = { ANGEL_API_KEY: 'KEY12345', ANGEL_CLIENT_CODE: 'A12345', ANGEL_PIN: '4321', ANGEL_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' };
const get = async (port, p, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {} return { status: r.status, text, body }; };
function bullsy(port, mockPort, env = {}) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, BULLSY_SKIP_ENV_FILE: '1', PORT: String(port), MARKET_DATA_PROVIDER: 'angelone', ANGEL_API_BASE: `http://127.0.0.1:${mockPort}`, ADMIN_PASSWORD: 'pw', BULLSY_POLL_INTERVAL_MS: '2000', ...CREDS, ...env } });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  return { stop: () => new Promise(r => { child.on('exit', r); child.kill(); }), logs: () => logs };
}
const ids = Object.keys(TOKENS), today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

ok(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000) === '287082' && totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109000) === '081804' && totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 2000000000000) === '279037', 'one-time codes match the published RFC 6238 test values');

/* delayed mode (default) */
{
  const mock = await startAngelMock({ port: 4861 }), app = bullsy(4761, 4861, { BULLSY_DATA_DELAY_DAYS: '1' }); await sleep(7000);
  const q = (await get(4761, '/api/market/quotes')).body;
  ok(ids.every(id => q.quotes[id].status === 'DELAYED' && q.quotes[id].price > 0), 'delayed mode: all 8 indices have a DELAYED value', JSON.stringify(ids.map(id => q.quotes[id].status)));
  ok(mock.state.logins === 1 && mock.state.quoteCalls.length === 0, 'the server signed in by itself once, and made no real-time quote calls');
  const sent = new Set(mock.state.candleCalls.map(c => c.exchange + '|' + c.symboltoken));
  ok(ids.every(id => sent.has(TOKENS[id].join('|'))), 'each index is requested with its Angel One exchange and token');
  mock.state.candleCalls.length = 0;
  const sizes = {}; for (const r of ['1W', '1M', '3M', '6M', '1Y', 'REPLAY']) sizes[r] = (await get(4761, `/api/market/history/NIFTYIT?range=${r}`)).body.candles.length;
  const calls = mock.state.candleCalls, by = iv => calls.filter(c => c.interval === iv);
  ok(sizes['1M'] < sizes['3M'] && sizes['3M'] < sizes['6M'] && sizes['6M'] < sizes['1Y'] && sizes['1Y'] < sizes.REPLAY && sizes['1W'] > 20, 'history ranges return different amounts of data', JSON.stringify(sizes));
  ok(by('THIRTY_MINUTE').length === 1 && by('ONE_DAY').length >= 4 && calls.every(c => /^\d{4}-\d{2}-\d{2} 09:15$/.test(c.fromdate) && c.todate === today + ' 15:30'), '1W asks for 30-minute candles, longer ranges for daily, with Angel\'s date format');
  mock.state.expireNext = true;
  const again = await get(4761, '/api/market/history/NIFTYAUTO?range=3M');
  ok(again.status === 200 && again.body.candles.length > 30 && mock.state.logins === 2, 'when the session expires the server signs in again and the request still succeeds');
  const adm = await get(4761, '/admin', AUTH), pub = (await get(4761, '/api/market/config')).text + (await get(4761, '/api/market/quotes')).text + (await get(4761, '/api/market/instruments')).text + (await get(4761, '/')).text + (await get(4761, '/js/market.js')).text;
  ok(/Angel One SmartAPI connection: <span class="ok">CONNECTED/.test(adm.text) && /Sign-in: <b>automatic/.test(adm.text), 'admin page shows Angel One CONNECTED with automatic sign-in');
  ok(![adm.text, pub, app.logs()].some(t => /KEY12345|4321\b|JBSWY3DPEHPK3PXP|jwt-\d/.test(t)), 'API key, PIN, TOTP secret and session token appear nowhere: not in pages, API or logs');
  await app.stop(); await mock.close();
}
/* real-time mode: polling */
{
  const mock = await startAngelMock({ port: 4862, missing: ['NIFTYPHARMA'] }), app = bullsy(4762, 4862, { BULLSY_DATA_DELAY_DAYS: '0' }); await sleep(5000);
  const s = (await get(4762, '/admin/status.json', AUTH)).body, n = s.quotes.NIFTY50;
  ok(n.source === 'rest' && n.price > 0 && Math.abs(n.change - (n.price - n.prevClose)) < 1e-9 && n.ts > Date.now() - 60000, 'real-time mode: quotes come from Angel\'s quote API with its own timestamp');
  ok(mock.state.quoteCalls[0].mode === 'FULL' && mock.state.quoteCalls[0].exchangeTokens.NSE.length === 7 && mock.state.quoteCalls[0].exchangeTokens.BSE[0] === '99919000', 'one quote call carries all 8 indices');
  ok(s.quotes.NIFTYPHARMA.status === 'UNAVAILABLE' && s.quotes.NIFTYPHARMA.price === null, 'an index Angel returns nothing for is UNAVAILABLE, not guessed');
  const c1 = mock.state.quoteCalls.length; await sleep(6000); const rate = (mock.state.quoteCalls.length - c1) / 6;
  ok(rate <= 0.6, `polling stays slow (${rate.toFixed(2)} calls/s; Angel allows 10/s)`);
  await app.stop(); await mock.close();
}
/* wrong PIN */
{
  const mock = await startAngelMock({ port: 4863 }), app = bullsy(4763, 4863, { ANGEL_PIN: '0000', BULLSY_DATA_DELAY_DAYS: '1' }); await sleep(7000);
  const q = (await get(4763, '/api/market/quotes')), adm = await get(4763, '/admin', AUTH);
  ok(Object.values(q.body.quotes).every(v => v.status === 'UNAVAILABLE' && v.price === null) && !/angel|password|totp|pin/i.test(q.text), 'failed sign-in: players see DATA UNAVAILABLE and no account details');
  ok(/DISCONNECTED/.test(adm.text) && /Invalid Client Code or Password/.test(adm.text), 'failed sign-in: admin page shows DISCONNECTED and Angel\'s reason');
  ok(mock.state.loginFailures <= 2, `failed sign-ins are not hammered (${mock.state.loginFailures} attempts in 7 s)`);
  await app.stop(); await mock.close();
}
/* not configured, and per-request limit */
{
  const app = bullsy(4764, 4899, { ANGEL_TOTP_SECRET: '' }); await sleep(2500);
  ok(/ANGEL_TOTP_SECRET are not all set/.test(app.logs()) && (await get(4764, '/api/health')).body.ok, 'missing settings: clear log message and the site still starts');
  await app.stop();
  const p = new AngelOneProvider({ apiKey: 'k', clientCode: 'c', pin: 'p', totpSecret: 'JBSWY3DPEHPK3PXP', apiBase: 'http://127.0.0.1:1', tokenOverrides: {} }, { info() {}, warn() {}, error() {} });
  let msg = ''; try { await p.fetchCandles('NIFTY50', 'days', 1, '2015-01-01', '2026-01-01'); } catch (e) { msg = e.message; }
  ok(/at most 2000 days/.test(msg), 'a span beyond Angel\'s per-request limit is refused with a clear message');
}
console.log(`\n${pass} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
