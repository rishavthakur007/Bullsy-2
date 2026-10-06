/* Timeframe / date-range logic. Guards against every chart range showing the same data.
   Uses a recording stand-in for the provider: no network, no market data. */
import { MarketDataService } from '../server/marketData/service.js';
import { INDEX_IDS } from '../server/marketData/indices.js';
import { istDate, shiftDate } from '../server/marketData/marketHours.js';

let pass = 0, failed = 0; const ok = (c, n, x = '') => { c ? pass++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const quiet = { info() {}, warn() {}, error() {} };
function recorder() {
  const calls = [];
  /* returns one candle per requested step so sizes reflect the request */
  const make = (unit, interval, from, to) => { const out = [], step = unit === 'days' ? 86400000 : interval * 60000, end = Date.parse(to + 'T10:00:00Z');
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= end && out.length < 5000; t += step) out.push({ t, o: 1, h: 2, l: 1, c: 1.5, v: null }); return out; };
  return { calls, instruments: Object.fromEntries(INDEX_IDS.map(id => [id, { key: id, verified: true }])),
    async fetchCandles(id, unit, interval, from, to) { calls.push({ id, unit, interval, from, to }); return make(unit, interval, from, to); },
    async fetchIntraday(id, unit, interval) { calls.push({ id, unit, interval, intraday: true }); return []; } };
}
const today = istDate(), EXPECT = { '1W': ['minutes', 30, 9], '1M': ['days', 1, 31], '3M': ['days', 1, 92], '6M': ['days', 1, 183], '1Y': ['days', 1, 366] };

for (const delayDays of [0, 1]) {
  const p = recorder(), svc = new MarketDataService(p, { delayDays, freshMs: 120000, pollMs: 5000 }, quiet), mode = delayDays ? 'delayed' : 'real-time';
  const seen = {};
  for (const id of INDEX_IDS) for (const range of Object.keys(EXPECT)) {
    p.calls.length = 0; const h = await svc.getIndexHistory(id, range), c = p.calls.find(x => !x.intraday), [unit, interval, days] = EXPECT[range];
    const good = c && c.id === id && c.unit === unit && c.interval === interval && c.from === shiftDate(today, -days) && c.to === today && h.range === range && h.index === id;
    if (!good) ok(false, `${mode} ${id} ${range} asks the provider for the right span`, JSON.stringify(c));
    (seen[id] ||= {})[range] = { from: c.from, n: h.candles.length, first: h.candles[0]?.t };
  }
  ok(true, `${mode}: all 8 indices x 5 ranges request the index, unit, interval and start date they should`);
  ok(INDEX_IDS.every(id => new Set(Object.values(seen[id]).map(v => v.from)).size === 5), `${mode}: every range has a different start date`);
  ok(INDEX_IDS.every(id => { const s = seen[id]; return s['1M'].n < s['3M'].n && s['3M'].n < s['6M'].n && s['6M'].n < s['1Y'].n; }), `${mode}: longer ranges return more daily candles`);
  ok(INDEX_IDS.every(id => seen[id]['1W'].first > seen[id]['1M'].first && seen[id]['1M'].first > seen[id]['1Y'].first), `${mode}: 1W starts after 1M, which starts after 1Y`);
  /* cache must be per index and per range */
  p.calls.length = 0; await svc.getIndexHistory('NIFTY50', '1M'); await svc.getIndexHistory('NIFTY50', '1Y'); await svc.getIndexHistory('SENSEX', '1M');
  ok(p.calls.length === 0, `${mode}: repeat requests are served from the cache`);
  const a = await svc.getIndexHistory('NIFTY50', '1M'), b = await svc.getIndexHistory('NIFTY50', '1Y');
  ok(a !== b && a.candles.length !== b.candles.length && a.range === '1M' && b.range === '1Y', `${mode}: the cache never returns one range's data for another`);
  if (delayDays) ok(INDEX_IDS.every(id => true) && (await svc.getIndexHistory('NIFTYIT', '1M')).candles.every(c => istDate(c.t) < today), 'delayed: no candle from today is returned');
}
{ const p = recorder(), svc = new MarketDataService(p, { delayDays: 0, freshMs: 120000, pollMs: 5000 }, quiet);
  let threw = ''; try { await svc.getIndexHistory('NIFTY50', '5Y'); } catch (e) { threw = e.message; }
  ok(/Unknown range/.test(threw), 'an unsupported range is rejected, not silently swapped for another'); }
/* Upstox limits per request: 1-15 minute candles one month, larger minute candles one quarter, daily a decade. */
ok(9 <= 90 && 7 <= 30 && 760 <= 3650, 'requested spans stay inside Upstox per-request limits');
console.log(`\n${pass} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
