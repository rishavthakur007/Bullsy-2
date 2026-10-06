/* Browser test: clicking a timeframe must hand the chart that timeframe's own candles.
   A recording stand-in replaces the chart library so we can see exactly what it is given.
   Needs Playwright (optional). */
import { spawn } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
import { startMock, KEYS } from './mock-upstox.js';
const require = createRequire(import.meta.url); const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failed = 0; const ok = (c, n, x = '') => { c ? pass++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const mock = await startMock({ port: 4850 });
const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, BULLSY_SKIP_ENV_FILE: '1', PORT: '4750', UPSTOX_API_BASE: 'http://127.0.0.1:4850', BULLSY_DATA_DELAY_DAYS: '1' } });
await sleep(3500);
const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 900 } }); const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); });
const bad = []; page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
await page.addInitScript(() => { window.__sets = []; window.__fits = [];
  window.LightweightCharts = { createChart: () => ({ addCandlestickSeries: () => ({ setData: d => window.__sets.push({ n: d.length, first: d[0]?.time, last: d.at(-1)?.time, firstClose: d[0]?.close, lastClose: d.at(-1)?.close }), update() {} }),
    timeScale: () => ({ fitContent() {}, setVisibleLogicalRange: r => window.__fits.push(r) }) }) }; });
await page.goto('http://127.0.0.1:4750/'); await page.waitForSelector('.pcard'); await page.click('[data-act=start]'); await page.waitForSelector('#tradebox'); await sleep(300);
const last = () => page.evaluate(() => ({ set: window.__sets.at(-1), fit: window.__fits.at(-1), note: document.querySelector('.chartnote').textContent }));
const WANT = { '1W': 5, '1M': 21, '3M': 63, '6M': 126, '1Y': 252 };
const all = {};
for (const id of Object.keys(KEYS)) {
  await page.click(`[data-sel=${id}]`); await sleep(120); const got = {};
  for (const r of ['1W', '1M', '1Y', '3M', '6M', '1W']) { await page.click(`[data-range="${r}"]`); await sleep(80); const v = await last(); got[r] = v;
    if (v.set.n !== WANT[r] || Math.abs(v.fit.to - (WANT[r] - 0.5)) > 1e-9 || !v.note.startsWith(`${r}: ${WANT[r]} real daily candles`)) ok(false, `${id} ${r}`, JSON.stringify(v)); }
  const truth = await page.evaluate(i => { const r = Market.state.replay, s = r.series[i]; return { end: r.dates[r.cursor], endClose: s.get(r.dates[r.cursor]).c, y: r.dates[r.cursor - 251], yClose: s.get(r.dates[r.cursor - 251]).c, w: r.dates[r.cursor - 4] }; }, id);
  ok(got['1W'].set.first === truth.w && got['1Y'].set.first === truth.y && got['1Y'].set.firstClose === truth.yClose && got['1M'].set.last === truth.end && got['1M'].set.lastClose === truth.endClose, `${id}: 1W, 1M and 1Y each get their own real candles, ending on the replay date`);
  ok(new Set(['1W', '1M', '3M', '6M', '1Y'].map(r => got[r].set.first)).size === 5, `${id}: five timeframes, five different start dates`);
  all[id] = got['1Y'].set.firstClose;
}
ok(new Set(Object.values(all)).size === 8, 'changing the index loads that index\'s own history');
await page.click('[data-range="1Y"]'); await page.click('[data-act=q-long]'); await sleep(150); let v = await last();
ok(v.set.n === 252 && v.fit.to === 251.5, 'after the page re-renders (a trade) the chart is refitted to the full timeframe');
const before = v.set.last; await page.click('[data-act=up]'); await sleep(300); v = await last();
ok(v.set.n === 252 && v.set.last > before, 'after a round the same timeframe reloads one trading day later');
await page.click('[data-range="1W"]'); await sleep(100); v = await last(); ok(v.set.n === 5 && v.set.last > before, '1W after a round is the latest 5 sessions');
ok(await page.locator('[data-range][disabled]').count() === 0, 'no timeframe is disabled when the data exists');
ok(errs.length === 0 && bad.length === 0, 'no console errors or failed API calls', errs.concat(bad).join(' | '));
await browser.close(); child.kill(); await mock.close();
console.log(`\n${pass} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
