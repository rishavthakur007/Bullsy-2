/* Lists index instruments from Upstox's instrument files, to find or confirm a key.
   Run: npm run find-keys            (all indices)
        npm run find-keys -- pharma  (filter by text) */
import zlib from 'node:zlib';
import { config } from '../server/config.js';
const filter = (process.argv[2] || '').toLowerCase();
const urls = config.upstox.instrumentsUrls.length ? config.upstox.instrumentsUrls : ['https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz', 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz'];
for (const url of urls) {
  try {
    const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    let buf = Buffer.from(await res.arrayBuffer()); if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const rows = JSON.parse(buf.toString('utf8')).filter(r => /_INDEX$/.test(r.segment || '') && (!filter || JSON.stringify(r).toLowerCase().includes(filter)));
    console.log(`\n${url}  (${rows.length} index rows)`);
    for (const r of rows) console.log(`  ${String(r.instrument_key).padEnd(40)} name: ${r.name}   symbol: ${r.trading_symbol}`);
  } catch (e) { console.log(`\n${url}  could not be loaded: ${e.message}`); }
}
