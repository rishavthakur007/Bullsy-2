/* Angel One SmartAPI adapter. Same interface as providers/upstox.js, so nothing else
   in Bullsy changes when the provider is switched (MARKET_DATA_PROVIDER=angelone).

   Endpoints used:
     POST /rest/auth/angelbroking/user/v1/loginByPassword          client code + PIN + TOTP -> session token
     POST /rest/secure/angelbroking/historical/v1/getCandleData    candles (needs the session token)
     POST /rest/secure/angelbroking/market/v1/quote/               snapshot quotes, all 8 indices in one call

   Differences from Upstox that matter:
   - Every call, including history, needs a logged-in session.
   - The login can be done by the server itself (PIN + TOTP), so no daily manual step,
     but it means the server holds full login details for the Angel One account.
   - This adapter polls quotes; it does not use Angel's WebSocket stream. */
import { ProviderError } from './errors.js';
import { totp } from './totp.js';

/* Index tokens as published by Angel One for SmartAPI. Override with ANGEL_TOKEN_<ID>=EXCHANGE|TOKEN. */
const CATALOG = {
  NIFTY50:     { exchange: 'NSE', token: '99926000' },
  SENSEX:      { exchange: 'BSE', token: '99919000' },
  NIFTYBANK:   { exchange: 'NSE', token: '99926009' },
  NIFTYIT:     { exchange: 'NSE', token: '99926008' },
  NIFTYAUTO:   { exchange: 'NSE', token: '99926029' },
  NIFTYFIN:    { exchange: 'NSE', token: '99926037' },
  NIFTYFMCG:   { exchange: 'NSE', token: '99926021' },
  NIFTYPHARMA: { exchange: 'NSE', token: '99926023' }
};
/* interval name and the most days Angel allows in one request */
const INTERVALS = { 'minutes:1': ['ONE_MINUTE', 30], 'minutes:3': ['THREE_MINUTE', 60], 'minutes:5': ['FIVE_MINUTE', 100], 'minutes:10': ['TEN_MINUTE', 100],
  'minutes:15': ['FIFTEEN_MINUTE', 200], 'minutes:30': ['THIRTY_MINUTE', 200], 'minutes:60': ['ONE_HOUR', 400], 'days:1': ['ONE_DAY', 2000] };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const AUTH_CODES = /^(AG800[1-3]|AB805[01]|AB1010|AB1011)$/;

export class AngelOneProvider {
  constructor(cfg, log = console) {
    this.name = 'angelone'; this.label = 'Angel One SmartAPI'; this.cfg = cfg; this.log = log;
    this.jwt = null; this.lastLoginAt = null; this.lastLoginError = null; this.lastAttempt = 0; this.loggingIn = null;
    this.queue = Promise.resolve(); this.lastCall = 0;
    this.instruments = {};
    for (const [id, c] of Object.entries(CATALOG)) {
      const [exchange, token] = (cfg.tokenOverrides[id] || `${c.exchange}|${c.token}`).split('|');
      this.instruments[id] = { key: `${exchange}|${token}`, exchange, token, verified: false, via: cfg.tokenOverrides[id] ? 'env override' : 'Angel One published index token (confirmed when data arrives)' };
    }
  }

  /* ---------- session ---------- */
  configured() { const c = this.cfg; return !!(c.apiKey && c.clientCode && c.pin && c.totpSecret); }
  hasToken() { return !!this.jwt; }
  authInfo() { return { kind: 'automatic', configured: this.configured(), loggedIn: !!this.jwt, lastLoginAt: this.lastLoginAt, lastError: this.lastLoginError }; }
  async resolveInstruments() { return this.instruments; }
  #headers(auth) {
    return { 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': this.cfg.apiKey, ...(auth ? { Authorization: 'Bearer ' + this.jwt } : {}) };
  }
  async #post(path, body, auth) {
    let res, text;
    try { res = await fetch(this.cfg.apiBase + path, { method: 'POST', headers: this.#headers(auth), body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); text = await res.text(); }
    catch (e) { throw new ProviderError('Could not reach Angel One: ' + (e.cause?.code || e.message)); }
    let json = null; try { json = JSON.parse(text); } catch {}
    if (/access rate/i.test(text)) throw new ProviderError('Angel One rate limit reached', { status: res.status, rateLimited: true });
    const code = json?.errorcode || json?.errorCode || '';
    if (!res.ok || !json || json.status === false || json.success === false) {
      const authFail = res.status === 401 || AUTH_CODES.test(code);
      throw new ProviderError(`Angel One ${res.status}${code ? ' ' + code : ''}: ${json?.message || text.slice(0, 120) || 'request failed'}`, { status: res.status, code, auth: authFail || (!auth), rateLimited: res.status === 429 });
    }
    return json;
  }
  /* One login at a time, and never more than one attempt every 30 seconds. */
  login(force = false) {
    if (this.loggingIn) return this.loggingIn;
    if (!this.configured()) return Promise.reject(new ProviderError('Angel One is not configured. Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and ANGEL_TOTP_SECRET on the server.', { auth: true }));
    const wait = this.lastAttempt + 30000 - Date.now();
    if (!force && wait > 0 && this.lastLoginError) return Promise.reject(new ProviderError(this.lastLoginError, { auth: true }));
    this.lastAttempt = Date.now();
    this.loggingIn = (async () => {
      try {
        const json = await this.#post('/rest/auth/angelbroking/user/v1/loginByPassword', { clientcode: this.cfg.clientCode, password: this.cfg.pin, totp: totp(this.cfg.totpSecret) }, false);
        if (!json.data?.jwtToken) throw new ProviderError('Angel One login returned no session token', { auth: true });
        this.jwt = json.data.jwtToken.replace(/^Bearer\s+/i, ''); this.lastLoginAt = Date.now(); this.lastLoginError = null;
        this.log.info('[angelone] signed in');
      } catch (e) { this.jwt = null; this.lastLoginError = e.message; e.auth = true; throw e; }
      finally { this.loggingIn = null; }
    })();
    return this.loggingIn;
  }
  relogin() { this.jwt = null; return this.login(true); }
  /* Authenticated call: spaced out to stay under Angel's 3 requests/second on candles; signs in again once if the session has expired. */
  #api(path, body) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        if (!this.jwt) await this.login();
        const wait = this.lastCall + 400 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.lastCall = Date.now();
        try { return await this.#post(path, body, true); }
        catch (e) { if (e.auth && attempt === 0) { this.jwt = null; continue; } throw e; }
      }
    };
    const p = this.queue.then(run, run); this.queue = p.catch(() => {}); return p;
  }
  #inst(id) { const i = this.instruments[id]; if (!i) throw new ProviderError('Unknown index ' + id); return i; }

  /* ---------- quotes ---------- */
  #time(s) {                                   // "06-Oct-2026 15:29:58" (IST)
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim()); if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
    return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6]) - 19800000;
  }
  async fetchQuotes(ids) {
    const exchangeTokens = {}; for (const id of ids) { const i = this.#inst(id); (exchangeTokens[i.exchange] ||= []).push(i.token); }
    const json = await this.#api('/rest/secure/angelbroking/market/v1/quote/', { mode: 'FULL', exchangeTokens });
    const out = {};
    for (const row of json.data?.fetched || []) {
      const id = Object.keys(this.instruments).find(k => this.instruments[k].token === String(row.symbolToken) && this.instruments[k].exchange === row.exchange); if (!id || !(row.ltp > 0)) continue;
      out[id] = { price: row.ltp, prevClose: row.close > 0 ? row.close : (Number.isFinite(row.netChange) ? row.ltp - row.netChange : null), open: row.open > 0 ? row.open : null, high: row.high > 0 ? row.high : null,
        low: row.low > 0 ? row.low : null, volume: row.tradeVolume > 0 ? row.tradeVolume : null, ts: this.#time(row.exchFeedTime) || this.#time(row.exchTradeTime) };
      this.instruments[id].verified = true; this.instruments[id].via = 'confirmed by data received';
    }
    return out;
  }

  /* ---------- candles ---------- */
  async #candles(id, unit, interval, fromText, toText, spanDays) {
    const spec = INTERVALS[`${unit}:${interval}`]; if (!spec) throw new ProviderError(`Angel One has no ${interval} ${unit} candles`);
    if (spanDays > spec[1]) throw new ProviderError(`Angel One allows at most ${spec[1]} days of ${spec[0]} candles per request (asked for ${spanDays})`);
    const i = this.#inst(id), json = await this.#api('/rest/secure/angelbroking/historical/v1/getCandleData', { exchange: i.exchange, symboltoken: i.token, interval: spec[0], fromdate: fromText, todate: toText });
    const out = (json.data || []).map(c => ({ t: Date.parse(c[0]), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] > 0 ? c[5] : null })).filter(c => Number.isFinite(c.t) && c.c > 0).sort((a, b) => a.t - b.t);
    if (out.length) { i.verified = true; i.via = 'confirmed by data received'; }
    return out;
  }
  /* unit: 'minutes' | 'days'; from/to: 'YYYY-MM-DD' IST dates, inclusive */
  fetchCandles(id, unit, interval, from, to) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    return this.#candles(id, unit, interval, `${from} 09:15`, `${to} 15:30`, days);
  }
  fetchIntraday(id, unit, interval) {
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    return this.#candles(id, unit, interval, `${today} 09:15`, `${today} 15:30`, 1);
  }
}
