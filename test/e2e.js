/* Browser test of the whole game against the test double (needs Playwright; optional). */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startMock } from './mock-upstox.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failed = 0; const ok = (c, n, x = '') => { c ? pass++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };

const mock = await startMock({ port: 4810 });
const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, BULLSY_SKIP_ENV_FILE: '1', PORT: '4710', UPSTOX_API_BASE: 'http://127.0.0.1:4810', UPSTOX_INSTRUMENTS_URLS: 'http://127.0.0.1:4810/instruments.json', UPSTOX_ACCESS_TOKEN: 'test-token', ADMIN_PASSWORD: 'pw', BULLSY_DATA_DELAY_DAYS: '0' } });
await sleep(3000);
const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const stub = process.env.STUB3D ? () => { const mk = () => { const f = function () {}; return new Proxy(f, { get: (t, k) => k === Symbol.toPrimitive ? () => 1 : k === 'then' ? undefined : mk(), set: () => true, apply: () => mk(), construct: () => mk() }); }; window.THREE = mk(); } : () => {};
await page.addInitScript(stub);
await page.goto('http://127.0.0.1:4710/'); await page.waitForSelector('.pcard'); await sleep(1500);
ok(await page.locator('.pcard').count() === 8, 'Market Pulse shows 8 index cards');
ok((await page.textContent('.banner')).includes('LIVE MARKET DATA'), 'banner says LIVE only because the feed is live');
const v1 = await page.textContent('[data-sel=NIFTY50] .pc-val'); await sleep(2500); const v2 = await page.textContent('[data-sel=NIFTY50] .pc-val');
ok(v1 !== v2, 'card value updates when a new genuine tick arrives', v1 + ' ' + v2);
await page.screenshot({ path: '/tmp/setup.png', fullPage: true });

/* ---- replay game ---- */
await page.click('[data-act=start]'); await page.waitForSelector('#tradebox');
ok((await page.textContent('.banner')).includes('HISTORICAL MARKET REPLAY'), 'replay is labelled as historical, never live');
const check = await page.evaluate(() => { const r = Market.state.replay, d = r.dates[r.cursor], c = r.series.NIFTYIT.get(d); return { same: Market.price('NIFTYIT') === c.c, n: r.dates.length - 1 - r.cursor }; });
ok(check.same && check.n === 8, 'replay price is the real candle close and 8 real days remain');
await page.click('[data-sel=NIFTYIT]'); await page.fill('#amt', '20000'); await page.click('[data-act=long]');
await page.click('[data-sel=NIFTYPHARMA]'); await page.fill('#amt', '20000'); await page.click('[data-act=short]');
await page.click('[data-sel=NIFTYBANK]'); await page.click('[data-act=q-long]'); await page.click('[data-sel=NIFTYFMCG]'); await page.click('[data-act=q-long]');
const before = await page.evaluate(() => ({ it: Market.price('NIFTYIT'), ph: Market.price('NIFTYPHARMA'), posIt: position('NIFTYIT'), posPh: position('NIFTYPHARMA'), tot: total() }));
ok(Math.abs(before.tot - 100000) < 0.01, 'opening positions does not change net worth');
await page.click('[data-act=hint]'); await page.click('[data-act=up]'); await sleep(300);
const after = await page.evaluate(() => ({ it: Market.price('NIFTYIT'), ph: Market.price('NIFTYPHARMA'), posIt: position('NIFTYIT'), posPh: position('NIFTYPHARMA'), recap: S.recap, round: S.round }));
ok(Math.abs(after.posIt.pnl - (after.it - before.it) * before.posIt.qty) < 0.01, 'LONG P&L = (current - entry) x units, from the real move');
ok(Math.abs(after.posPh.pnl - (before.ph - after.ph) * before.posPh.qty) < 0.01, 'SHORT P&L = (entry - current) x units, from the real move');
const race = await page.evaluate(() => { const r = Market.state.replay, a = r.dates[r.cursor - 1], b = r.dates[r.cursor]; const real = SECTORS().map(s => ({ id: s.id, ret: (r.series[s.id].get(b).c / r.series[s.id].get(a).c - 1) * 100 })).sort((x, y) => y.ret - x.ret); return { real: real[0].id, shown: S.recap.secs[0].id }; });
ok(race.real === race.shown, 'Sector Race winner is the sector with the best real move');
await page.screenshot({ path: '/tmp/play.png', fullPage: true });
await page.click('[data-sel=NIFTYIT]'); await page.click('[data-act=close]');
for (let i = 0; i < 7; i++) { await page.click(i % 2 ? '[data-act=up]' : '[data-act=down]'); await sleep(120); }
await page.waitForSelector('.rank');
const fin = await page.evaluate(() => ({ idx: S.final.idx, expect: setup.budget * Market.price('NIFTY50') / S.startPx.NIFTY50, tips: S.final.review.tips, facts: S.final.review.facts, xp: S.xp }));
ok(Math.abs(fin.idx - fin.expect) < 0.01, 'benchmark is real NIFTY 50 performance over the same days');
ok(fin.facts.positions.length >= 3 && fin.facts.rounds.length === 8 && fin.xp > 0, 'coach facts hold the real trades and rounds; XP awarded');
console.log('   sample tip:', fin.tips[0]);
await page.screenshot({ path: '/tmp/result.png', fullPage: true });

/* ---- live game (round shortened for the test) ---- */
await page.click('[data-act=reset]'); await page.click('[data-set=mode][data-val=live]'); await page.click('[data-act=start]'); await page.waitForSelector('#tradebox');
await page.evaluate(() => { setup.liveMin = 0.06; });
await page.click('[data-act=q-short]'); const p0 = await page.evaluate(() => S.pending); await page.click('[data-act=down]');
ok(await page.locator('#cd').count() === 1, 'live round waits on the real clock');
await page.waitForFunction(() => S.round === 1, null, { timeout: 15000 });
const live = await page.evaluate(() => ({ r: S.log.rounds[0], status: Market.quote('NIFTY50').status }));
ok(live.r.nifty50MovePct !== undefined && live.status === 'LIVE', 'live round settled from genuine prices at start and end', JSON.stringify(live));
ok(errs.length === 0, 'no page errors', errs.join(' | '));
await browser.close(); child.kill(); await mock.close();
console.log(`\n${pass} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
