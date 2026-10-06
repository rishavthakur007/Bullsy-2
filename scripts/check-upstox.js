/* Checks the REAL Upstox connection with your own credentials.
   Run: npm run check   (after setting .env and logging in once today) */
import { config } from '../server/config.js';
import { UpstoxProvider } from '../server/marketData/providers/upstox.js';
import { INDICES, INDEX_IDS } from '../server/marketData/indices.js';
import { istDate, shiftDate, inScheduledSession } from '../server/marketData/marketHours.js';

const quiet = { warn() {}, info() {}, error() {} };
const p = new UpstoxProvider(config.upstox, quiet);
let failed = 0;
const line = (ok, name, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

console.log(`Upstox base: ${config.upstox.apiBase}   token present: ${p.hasToken() ? 'yes' : 'NO'}   market hours now: ${inScheduledSession() ? 'yes' : 'no'}\n`);
const inst = await p.resolveInstruments();
for (const i of INDICES) line(inst[i.id].verified, `instrument key  ${i.name}`, `${inst[i.id].key}  (${inst[i.id].via})`);

console.log('');
let quotes = {};
try { quotes = await p.fetchQuotes(INDEX_IDS); line(true, 'API authentication'); }
catch (e) { line(false, 'API authentication', e.message); }
for (const i of INDICES) { const q = quotes[i.id]; line(!!q, `quote  ${i.name}`, q ? `${q.price}  prev close ${q.prevClose ?? 'n/a'}  at ${q.ts ? new Date(q.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'no timestamp'}` : 'no data returned'); }

console.log('');
const today = istDate();
for (const i of INDICES) {
  try { const c = await p.fetchCandles(i.id, 'days', 1, shiftDate(today, -40), today); line(c.length > 5, `daily history  ${i.name}`, `${c.length} candles, last ${c.length ? istDate(c.at(-1).t) + ' close ' + c.at(-1).c : '-'}`); }
  catch (e) { line(false, `daily history  ${i.name}`, e.message); }
}
try { const c = await p.fetchCandles('NIFTY50', 'minutes', 5, shiftDate(today, -7), today); line(c.length > 10, 'intraday history (5-minute, past week)', `${c.length} candles`); } catch (e) { line(false, 'intraday history (5-minute, past week)', e.message); }
try { const c = await p.fetchIntraday('NIFTY50', 'minutes', 5); console.log(`INFO  today's 5-minute candles: ${c.length} (0 is normal before the market opens or on a holiday)`); } catch (e) { line(false, "today's intraday candles", e.message); }

console.log('\nListening to the WebSocket feed for 12 seconds...');
const seen = {}; let segments = null, state = [];
p.startStream(INDEX_IDS, { onQuotes: q => { for (const id of Object.keys(q)) seen[id] = (seen[id] || 0) + 1; }, onSegments: s => { segments = s; }, onState: (s, e) => state.push(s + (e ? ': ' + e.message : '')) });
await new Promise(r => setTimeout(r, 12000)); p.stopStream();
line(state.includes('open'), 'WebSocket connects', state.join(' | '));
line(!!segments, 'WebSocket market status received', segments ? `NSE_INDEX ${segments.NSE_INDEX}, BSE_INDEX ${segments.BSE_INDEX}` : '');
for (const i of INDICES) line(!!seen[i.id], `WebSocket data  ${i.name}`, `${seen[i.id] || 0} messages` + (!seen[i.id] && !inScheduledSession() ? ' (market is closed: only a snapshot is expected)' : ''));

console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
