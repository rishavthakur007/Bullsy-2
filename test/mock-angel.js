/* TEST DOUBLE ONLY: a stand-in for Angel One SmartAPI so tests run without an account.
   Fixed fixture numbers, no randomness, NOT market data. Never used by the real server. */
import http from 'node:http';
import { totp } from '../server/marketData/providers/totp.js';

export const TOKENS = { NIFTY50: ['NSE', '99926000'], SENSEX: ['BSE', '99919000'], NIFTYBANK: ['NSE', '99926009'], NIFTYIT: ['NSE', '99926008'], NIFTYAUTO: ['NSE', '99926029'], NIFTYFIN: ['NSE', '99926037'], NIFTYFMCG: ['NSE', '99926021'], NIFTYPHARMA: ['NSE', '99926023'] };
const BASE = { NIFTY50: 20000, SENSEX: 66000, NIFTYBANK: 45000, NIFTYIT: 30000, NIFTYAUTO: 18000, NIFTYFIN: 21000, NIFTYFMCG: 50000, NIFTYPHARMA: 15000 };
const STEPS = [0.4, -0.3, 0.8, -0.6, 0.2, 1.1, -0.9, 0.3, -0.2, 0.5], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dstr = ms => new Date(ms + 19800000).toISOString().slice(0, 10);
const idOf = (ex, tok) => Object.keys(TOKENS).find(id => TOKENS[id][0] === ex && TOKENS[id][1] === String(tok));

export function startAngelMock({ port, apiKey = 'KEY12345', clientCode = 'A12345', pin = '4321', secret = 'JBSWY3DPEHPK3PXP', missing = [] } = {}) {
  const state = { logins: 0, loginFailures: 0, candleCalls: [], quoteCalls: [], valid: new Set(), expireNext: false };
  function daily(id, from, to) {
    const out = []; let price = BASE[id], i = 0; const end = Math.min(Date.parse(to + 'T00:00:00+05:30'), Date.now() - 86400000);
    for (let t = Date.parse('2024-01-01T00:00:00+05:30'); t <= end; t += 86400000) {
      const wd = new Date(t + 19800000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      const o = price, c = +(price * (1 + STEPS[(i + id.length) % STEPS.length] / 100)).toFixed(2); i++; price = c;
      if (dstr(t) >= from) out.push([dstr(t) + 'T00:00:00+05:30', o, Math.max(o, c) + 5, Math.min(o, c) - 5, c, 0]);
    }
    return out;
  }
  function minutes(id, from, to, every) {
    const out = []; for (const d of daily(id, from, to)) { const n = Math.floor(375 / every), day = d[0].slice(0, 10);
      for (let k = 0; k < n; k++) { const p = d[1] + (d[4] - d[1]) * (k + 1) / n, hh = 9 * 60 + 15 + k * every; out.push([`${day}T${String(Math.floor(hh / 60)).padStart(2, '0')}:${String(hh % 60).padStart(2, '0')}:00+05:30`, +(d[1] + (d[4] - d[1]) * k / n).toFixed(2), p + 1, p - 1, +p.toFixed(2), 0]); } }
    return out;
  }
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    if (req.headers['x-privatekey'] !== apiKey) return send(res, 200, { status: false, message: 'Invalid API Key', errorcode: 'AG8004', data: null });
    if (req.url === '/rest/auth/angelbroking/user/v1/loginByPassword') {
      const now = Date.now(), good = body.clientcode === clientCode && body.password === pin && [0, -30000, 30000].some(d => totp(secret, now + d) === body.totp);
      if (!good) { state.loginFailures++; return send(res, 200, { status: false, message: body.password !== pin || body.clientcode !== clientCode ? 'Invalid Client Code or Password' : 'Invalid totp', errorcode: 'AB1050', data: null }); }
      const jwt = 'jwt-' + (++state.logins); state.valid.add(jwt);
      return send(res, 200, { status: true, message: 'SUCCESS', errorcode: '', data: { jwtToken: jwt, refreshToken: 'r', feedToken: 'f' } });
    }
    const jwt = (req.headers.authorization || '').replace('Bearer ', '');
    if (state.expireNext) { state.expireNext = false; state.valid.clear(); }
    if (!state.valid.has(jwt)) return send(res, 200, { success: false, message: 'Invalid Token', errorCode: 'AG8001', data: '' });
    if (req.url === '/rest/secure/angelbroking/historical/v1/getCandleData') {
      state.candleCalls.push(body); const id = idOf(body.exchange, body.symboltoken);
      if (!id || missing.includes(id)) return send(res, 200, { status: true, message: 'SUCCESS', errorcode: '', data: [] });
      const from = body.fromdate.slice(0, 10), to = body.todate.slice(0, 10);
      return send(res, 200, { status: true, message: 'SUCCESS', errorcode: '', data: body.interval === 'ONE_DAY' ? daily(id, from, to) : minutes(id, from, to, { FIVE_MINUTE: 5, THIRTY_MINUTE: 30 }[body.interval]) });
    }
    if (req.url === '/rest/secure/angelbroking/market/v1/quote/') {
      state.quoteCalls.push(body); const fetched = [], n = new Date(Date.now() + 19800000);
      const time = `${String(n.getUTCDate()).padStart(2, '0')}-${MON[n.getUTCMonth()]}-${n.getUTCFullYear()} ${n.toISOString().slice(11, 19)}`;
      for (const [ex, toks] of Object.entries(body.exchangeTokens || {})) for (const tok of toks) { const id = idOf(ex, tok); if (!id || missing.includes(id)) continue;
        const prev = daily(id, '2024-01-01', dstr(Date.now())).at(-1)[4], ltp = +(prev * 1.002).toFixed(2);
        fetched.push({ exchange: ex, tradingSymbol: id, symbolToken: tok, ltp, open: prev + 10, high: prev + 60, low: prev - 60, close: prev, netChange: +(ltp - prev).toFixed(2), percentChange: 0.2, tradeVolume: 0, exchFeedTime: time, exchTradeTime: time }); }
      return send(res, 200, { status: true, message: 'SUCCESS', errorcode: '', data: { fetched, unfetched: [] } });
    }
    send(res, 404, { status: false, message: 'not found', errorcode: 'AB0000' });
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ state, close: () => new Promise(d => { server.close(d); server.closeAllConnections?.(); }) })));
}
