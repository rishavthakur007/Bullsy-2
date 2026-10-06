/* TEST DOUBLE ONLY. A tiny stand-in for the Upstox API so the automated tests
   can run without credentials or internet. It is never used by the real server:
   it is only reached when a test sets UPSTOX_API_BASE to its address.
   Values are fixed fixtures (no randomness) and are NOT market data. */
import http from 'node:http';
import crypto from 'node:crypto';
import { FeedResponse } from '../server/marketData/providers/upstoxProto.js';

export const KEYS = { NIFTY50: 'NSE_INDEX|Nifty 50', SENSEX: 'BSE_INDEX|SENSEX', NIFTYBANK: 'NSE_INDEX|Nifty Bank', NIFTYIT: 'NSE_INDEX|Nifty IT', NIFTYAUTO: 'NSE_INDEX|Nifty Auto',
  NIFTYFIN: 'NSE_INDEX|Nifty Fin Service', NIFTYFMCG: 'NSE_INDEX|Nifty FMCG', NIFTYPHARMA: 'NSE_INDEX|Nifty Pharma' };
const BASE = { NIFTY50: 20000, SENSEX: 66000, NIFTYBANK: 45000, NIFTYIT: 30000, NIFTYAUTO: 18000, NIFTYFIN: 21000, NIFTYFMCG: 50000, NIFTYPHARMA: 15000 };
const STEPS = [0.4, -0.3, 0.8, -0.6, 0.2, 1.1, -0.9, 0.3, -0.2, 0.5];   // fixed daily % pattern
const idOf = key => Object.keys(KEYS).find(id => KEYS[id] === key);
const dstr = ms => new Date(ms + 19800000).toISOString().slice(0, 10);

/* ---- protobuf writer (tests only), mirrors the reader's schema ---- */
function vint(n) { let v = BigInt.asUintN(64, BigInt(n)); const out = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
const tag = (f, w) => vint((f << 3) | w);
function encVal(f, type, v) {
  if (type === 'double') { const b = Buffer.alloc(8); b.writeDoubleLE(v); return [...tag(f, 1), ...b]; }
  if (type === 'int64') return [...tag(f, 0), ...vint(v)];
  if (type === 'string') { const b = Buffer.from(String(v)); return [...tag(f, 2), ...vint(b.length), ...b]; }
  if (type.enum) return [...tag(f, 0), ...vint(type.enum.indexOf(v))];
  const b = encode(v, type); return [...tag(f, 2), ...vint(b.length), ...b];
}
export function encode(obj, schema = FeedResponse) {
  const out = [];
  for (const [f, [name, type, kind]] of Object.entries(schema)) {
    const v = obj[name]; if (v === undefined || v === null) continue;
    if (kind === 'map') for (const [k, mv] of Object.entries(v)) { const e = [...encVal(1, 'string', k), ...encVal(2, type, mv)]; out.push(...tag(+f, 2), ...vint(e.length), ...e); }
    else if (kind === 'repeated') for (const item of v) out.push(...encVal(+f, type, item));
    else out.push(...encVal(+f, type, v));
  }
  return Buffer.from(out);
}

export function startMock({ port, token = 'test-token', segment = 'NORMAL_OPEN', missing = [], stream = true } = {}) {
  const state = { tick: 0, last: {}, sockets: new Set(), quoteCalls: 0 };
  /* fixture daily candles on weekdays, ending yesterday */
  function daily(id, from, to) {
    const out = []; let price = BASE[id], i = 0;
    const end = Math.min(Date.parse(to + 'T00:00:00+05:30'), Date.now() - 86400000);
    for (let t = Date.parse('2024-01-01T00:00:00+05:30'); t <= end; t += 86400000) {
      const wd = new Date(t + 19800000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      const o = price, c = +(price * (1 + STEPS[(i + id.length) % STEPS.length] / 100)).toFixed(2); i++; price = c;
      if (dstr(t) >= from) out.push([dstr(t) + 'T00:00:00+05:30', o, Math.max(o, c) + 5, Math.min(o, c) - 5, c, 0, 0]);
    }
    return out.reverse();                        // Upstox returns newest first
  }
  function minutes(id, from, to, every) {
    const days = daily(id, from, to).reverse(), out = [];
    for (const d of days) { const start = Date.parse(d[0].slice(0, 10) + 'T09:15:00+05:30'), n = Math.floor(375 / every);
      for (let k = 0; k < n; k++) { const p = d[1] + (d[4] - d[1]) * (k + 1) / n; out.push([new Date(start + k * every * 60000).toISOString(), +(d[1] + (d[4] - d[1]) * k / n).toFixed(2), p + 1, p - 1, +p.toFixed(2), 0, 0]); } }
    return out.reverse();
  }
  function quote(id) {
    const d = daily(id, '2024-01-01', dstr(Date.now())), prev = d[0][4];
    const price = +(prev * (1 + (state.tick % 7 - 3) * 0.001)).toFixed(2);     // fixed saw-tooth around previous close
    state.last[id] = price; return { price, prev };
  }
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'), parts = url.pathname.split('/').map(decodeURIComponent);
    const authed = req.headers.authorization === 'Bearer ' + token;
    const deny = () => json(res, 401, { status: 'error', errors: [{ errorCode: 'UDAPI100050', message: 'Invalid token used to access API' }] });
    if (url.pathname === '/instruments.json') return json(res, 200, Object.entries(KEYS).filter(([id]) => !missing.includes(id)).map(([id, key]) => ({ segment: key.split('|')[0], name: key.split('|')[1], instrument_type: 'INDEX', instrument_key: key, trading_symbol: id })));
    if (url.pathname === '/v2/market-quote/quotes') {
      if (!authed) return deny(); state.quoteCalls++; state.tick++;
      const data = {};
      for (const key of url.searchParams.get('instrument_key').split(',')) { const id = idOf(key); if (!id || missing.includes(id)) continue; const q = quote(id);
        data[key.replace('|', ':')] = { ohlc: { open: q.prev + 10, high: q.prev + 60, low: q.prev - 60, close: q.prev }, timestamp: new Date().toISOString(), instrument_token: key, symbol: id, last_price: q.price, volume: 0, net_change: +(q.price - q.prev).toFixed(2), last_trade_time: String(Date.now()) }; }
      return json(res, 200, { status: 'success', data });
    }
    if (url.pathname.startsWith('/v3/historical-candle/intraday/')) { const id = idOf(parts[4]); return id ? json(res, 200, { status: 'success', data: { candles: [] } }) : json(res, 400, { status: 'error', errors: [{ errorCode: 'UDAPI100011', message: 'Invalid Instrument key' }] }); }
    if (url.pathname.startsWith('/v3/historical-candle/')) {
      const [, , , key, unit, interval, to, from] = parts, id = idOf(key);
      if (!id || missing.includes(id)) return json(res, 400, { status: 'error', errors: [{ errorCode: 'UDAPI100011', message: 'Invalid Instrument key' }] });
      return json(res, 200, { status: 'success', data: { candles: unit === 'days' ? daily(id, from, to) : minutes(id, from, to, +interval) } });
    }
    if (url.pathname === '/v3/feed/market-data-feed/authorize') { if (!authed) return deny(); if (!stream) return json(res, 500, { status: 'error', errors: [{ message: 'feed disabled in this test' }] });
      return json(res, 200, { status: 'success', data: { authorized_redirect_uri: `ws://127.0.0.1:${port}/feed?code=test` } }); }
    json(res, 404, { status: 'error', errors: [{ message: 'not found' }] });
  });
  /* minimal WebSocket server: handshake + unmasked binary frames */
  const frame = buf => { const len = buf.length, head = len < 126 ? Buffer.from([0x82, len]) : Buffer.from([0x82, 126, len >> 8, len & 255]); return Buffer.concat([head, buf]); };
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    state.sockets.add(socket); let timer = null;
    socket.write(frame(encode({ type: 'market_info', currentTs: Date.now(), marketInfo: { segmentStatus: { NSE_INDEX: segment, BSE_INDEX: segment } } })));
    const sendTick = () => {
      state.tick++; const feeds = {};
      for (const [id, key] of Object.entries(KEYS)) { if (missing.includes(id)) continue; const q = quote(id);
        feeds[key] = { fullFeed: { indexFF: { ltpc: { ltp: q.price, ltt: Date.now(), ltq: 0, cp: q.prev }, marketOHLC: { ohlc: [{ interval: '1d', open: q.prev + 10, high: q.prev + 60, low: q.prev - 60, close: q.price, vol: 0, ts: Date.now() }] } } } }; }
      socket.write(frame(encode({ type: 'live_feed', feeds, currentTs: Date.now() })));
    };
    socket.on('data', d => { const op = d[0] & 15; if (op === 8) return socket.end(); if (op === 2 && !timer) { state.subscribed = true; sendTick(); timer = setInterval(sendTick, 700); } });
    const done = () => { clearInterval(timer); state.sockets.delete(socket); }; socket.on('close', done); socket.on('error', done);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ state, close: () => new Promise(r => { for (const s of state.sockets) s.destroy(); server.close(r); server.closeAllConnections?.(); }) })));
}
