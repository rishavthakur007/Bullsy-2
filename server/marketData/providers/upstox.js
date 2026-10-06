/* Upstox adapter. This is the ONLY file that knows Upstox instrument keys,
   endpoints and response formats. Everything it returns is normalised, so the
   rest of Bullsy never depends on Upstox and the provider can be swapped.

   Endpoints used (see README for links):
     GET  /v2/market-quote/quotes?instrument_key=a,b        (auth)   snapshot quotes
     GET  /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}  historical candles
     GET  /v3/historical-candle/intraday/{key}/{unit}/{interval}     today's candles
     GET  /v3/feed/market-data-feed/authorize               (auth)   WebSocket URL
     WSS  Market Data Feed V3 (protobuf)                             streaming ticks
     GET  /v2/login/authorization/dialog, POST /v2/login/authorization/token  OAuth
*/
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { decode } from './upstoxProto.js';
import { ProviderError } from './errors.js';
export { ProviderError };

/* Expected keys. They are checked against Upstox's instrument list at startup
   and can be overridden with UPSTOX_KEY_<ID> in .env. */
const CATALOG = {
  NIFTY50:     { key: 'NSE_INDEX|Nifty 50',          names: ['nifty 50'],                                  symbols: ['nifty', 'nifty 50'] },
  SENSEX:      { key: 'BSE_INDEX|SENSEX',            names: ['sensex', 's&p bse sensex', 'bse sensex'],     symbols: ['sensex'] },
  NIFTYBANK:   { key: 'NSE_INDEX|Nifty Bank',        names: ['nifty bank'],                                symbols: ['banknifty', 'nifty bank'] },
  NIFTYIT:     { key: 'NSE_INDEX|Nifty IT',          names: ['nifty it'],                                  symbols: ['niftyit', 'nifty it'] },
  NIFTYAUTO:   { key: 'NSE_INDEX|Nifty Auto',        names: ['nifty auto'],                                symbols: ['niftyauto', 'nifty auto'] },
  NIFTYFIN:    { key: 'NSE_INDEX|Nifty Fin Service', names: ['nifty fin service', 'nifty financial services'], symbols: ['finnifty', 'nifty fin service'] },
  NIFTYFMCG:   { key: 'NSE_INDEX|Nifty FMCG',        names: ['nifty fmcg'],                                symbols: ['niftyfmcg', 'nifty fmcg'] },
  NIFTYPHARMA: { key: 'NSE_INDEX|Nifty Pharma',      names: ['nifty pharma'],                              symbols: ['niftypharma', 'nifty pharma'] }
};

export class UpstoxProvider {
  constructor(cfg, log = console) {
    this.name = 'upstox'; this.label = 'Upstox'; this.cfg = cfg; this.log = log;
    this.token = cfg.accessToken || this.#readTokenFile();
    this.instruments = {};            // id -> { key, verified, via }
    for (const id of Object.keys(CATALOG)) this.instruments[id] = { key: cfg.keyOverrides[id] || CATALOG[id].key, verified: false, via: cfg.keyOverrides[id] ? 'env override' : 'default (not yet checked)' };
    this.queue = Promise.resolve(); this.lastCall = 0;
    this.ws = null; this.wantStream = false; this.backoff = 1000; this.retryTimer = null;
  }

  /* ---------- credentials ---------- */
  #readTokenFile() {
    try { const t = JSON.parse(fs.readFileSync(this.cfg.tokenFile, 'utf8')); return t.access_token || ''; } catch { return ''; }
  }
  hasToken() { return !!this.token; }
  authInfo() { const t = this.tokenInfo(); return { kind: 'manual', configured: !!(this.cfg.clientId && this.cfg.clientSecret) || !!this.token, loggedIn: !!this.token, lastLoginAt: t.savedAt ? Date.parse(t.savedAt) : null, lastError: null }; }
  tokenInfo() { try { return { present: !!this.token, savedAt: JSON.parse(fs.readFileSync(this.cfg.tokenFile, 'utf8')).saved_at || null }; } catch { return { present: !!this.token, savedAt: null }; } }
  setToken(token) {
    this.token = token;
    try { fs.writeFileSync(this.cfg.tokenFile, JSON.stringify({ access_token: token, saved_at: new Date().toISOString() }), { mode: 0o600 }); }
    catch (e) { this.log.warn('[upstox] could not save token file:', e.message); }
  }
  loginUrl(state) {
    const q = new URLSearchParams({ response_type: 'code', client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, state });
    return `${this.cfg.apiBase}/v2/login/authorization/dialog?${q}`;
  }
  async exchangeCode(code) {
    const body = new URLSearchParams({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: this.cfg.redirectUri, grant_type: 'authorization_code' });
    const res = await fetch(`${this.cfg.apiBase}/v2/login/authorization/token`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new ProviderError('Upstox did not return an access token: ' + (json.errors?.[0]?.message || res.status), { status: res.status, auth: true });
    this.setToken(json.access_token);
  }

  /* ---------- HTTP with a small rate limiter (well under Upstox's 50/s, 500/min, 2000 per 30 min) ---------- */
  #api(path, { auth = false } = {}) {
    const run = async () => {
      const wait = this.lastCall + 150 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastCall = Date.now();
      if (auth && !this.token) throw new ProviderError('No Upstox access token. Sign in at /admin to connect the Upstox account.', { auth: true });
      let res;
      try {
        res = await fetch(this.cfg.apiBase + path, { headers: { Accept: 'application/json', ...(auth ? { Authorization: 'Bearer ' + this.token } : {}) }, signal: AbortSignal.timeout(12000) });
      } catch (e) { throw new ProviderError('Could not reach Upstox: ' + (e.cause?.code || e.message)); }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status === 'error') {
        const err = json?.errors?.[0] || {}, code = err.errorCode || err.error_code;
        const authFail = res.status === 401 || code === 'UDAPI100050';
        throw new ProviderError(`Upstox ${res.status}${code ? ' ' + code : ''}: ${err.message || 'request failed'}` + (authFail ? ' (access token missing, invalid or expired: tokens end at 3:30 AM IST daily)' : ''),
          { status: res.status, code, auth: authFail, rateLimited: res.status === 429 });
      }
      return json;
    };
    const p = this.queue.then(run, run); this.queue = p.catch(() => {}); return p;
  }

  /* ---------- instruments: verify the 8 keys against Upstox's own list ---------- */
  async resolveInstruments() {
    const found = [];
    if (!this.cfg.instrumentsUrls.length) return this.instruments;   // keys are confirmed when data arrives
    for (const url of this.cfg.instrumentsUrls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        let buf = Buffer.from(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        for (const row of JSON.parse(buf.toString('utf8'))) if (row.instrument_key && /_INDEX$/.test(row.segment || '')) found.push(row);
      } catch (e) { this.log.warn(`[upstox] instrument list ${url} not loaded: ${e.message}`); }
    }
    if (!found.length) { this.log.warn('[upstox] instrument list unavailable; using default keys, unverified until a quote succeeds'); return this.instruments; }
    const byKey = new Map(found.map(r => [r.instrument_key, r]));
    for (const [id, cat] of Object.entries(CATALOG)) {
      const want = this.cfg.keyOverrides[id] || cat.key;
      if (byKey.has(want)) { this.instruments[id] = { key: want, verified: true, via: 'instrument list' }; continue; }
      const hit = found.find(r => cat.names.includes(String(r.name || '').toLowerCase())) || found.find(r => cat.symbols.includes(String(r.trading_symbol || '').toLowerCase()));
      if (hit) { this.instruments[id] = { key: hit.instrument_key, verified: true, via: 'instrument list (matched by name)' }; this.log.warn(`[upstox] ${id}: expected key "${want}" not found, using "${hit.instrument_key}"`); }
      else { this.instruments[id] = { key: want, verified: false, via: 'not found in instrument list' }; this.log.warn(`[upstox] ${id}: no matching index in the instrument list. Set UPSTOX_KEY_${id} in .env (npm run find-keys lists candidates).`); }
    }
    return this.instruments;
  }
  #key(id) { const k = this.instruments[id]?.key; if (!k) throw new ProviderError('Unknown index ' + id); return k; }
  #idForKey(key) { return Object.keys(this.instruments).find(id => this.instruments[id].key === key); }

  /* ---------- quotes (REST snapshot) ---------- */
  async fetchQuotes(ids) {
    const keys = ids.map(id => this.#key(id));
    const json = await this.#api('/v2/market-quote/quotes?instrument_key=' + encodeURIComponent(keys.join(',')), { auth: true });
    const out = {};
    for (const row of Object.values(json.data || {})) {
      const id = this.#idForKey(row.instrument_token || row.instrument_key); if (!id || !(row.last_price > 0)) continue;
      const ts = Date.parse(row.timestamp) || +row.last_trade_time || null;
      out[id] = {
        price: row.last_price,
        prevClose: Number.isFinite(row.net_change) ? row.last_price - row.net_change : null,
        open: row.ohlc?.open > 0 ? row.ohlc.open : null, high: row.ohlc?.high > 0 ? row.ohlc.high : null, low: row.ohlc?.low > 0 ? row.ohlc.low : null,
        volume: row.volume > 0 ? row.volume : null, ts
      };
      this.instruments[id].verified = true;
    }
    return out;
  }

  /* ---------- candles ---------- */
  #candles(json) {
    return (json.data?.candles || []).map(c => ({ t: Date.parse(c[0]), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] > 0 ? c[5] : null }))
      .filter(c => Number.isFinite(c.t) && c.c > 0).sort((a, b) => a.t - b.t);
  }
  async #candleCall(path) {
    try { return await this.#api(path); }
    catch (e) { if (e.status === 401 && this.token) return this.#api(path, { auth: true }); throw e; }
  }
  /* unit: 'minutes' | 'days'; from/to: 'YYYY-MM-DD' (IST dates, inclusive) */
  async fetchCandles(id, unit, interval, from, to) {
    const out = this.#candles(await this.#candleCall(`/v3/historical-candle/${encodeURIComponent(this.#key(id))}/${unit}/${interval}/${to}/${from}`));
    if (out.length && !this.instruments[id].verified) this.instruments[id] = { ...this.instruments[id], verified: true, via: 'confirmed by data received' };
    return out;
  }
  async fetchIntraday(id, unit, interval) {
    return this.#candles(await this.#candleCall(`/v3/historical-candle/intraday/${encodeURIComponent(this.#key(id))}/${unit}/${interval}`));
  }

  /* ---------- streaming (Market Data Feed V3) ---------- */
  startStream(ids, handlers) { this.wantStream = true; this.streamIds = ids; this.handlers = handlers; this.#connect(); }
  stopStream() { this.wantStream = false; clearTimeout(this.retryTimer); try { this.ws?.close(); } catch {} this.ws = null; }
  restartStream() { if (!this.wantStream) return; clearTimeout(this.retryTimer); try { this.ws?.close(); } catch {} this.ws = null; this.backoff = 1000; this.#connect(); }
  #retry(ms) { if (!this.wantStream) return; clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.#connect(), ms); }
  async #connect() {
    const h = this.handlers;
    try {
      const auth = await this.#api('/v3/feed/market-data-feed/authorize', { auth: true });
      const url = auth.data?.authorized_redirect_uri || auth.data?.authorizedRedirectUri;
      if (!url) throw new ProviderError('Upstox did not return a WebSocket address');
      const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; this.ws = ws;
      ws.onopen = () => {
        this.backoff = 1000;
        const keys = this.streamIds.map(id => this.#key(id));
        // Upstox requires the request as a binary frame, not text.
        ws.send(Buffer.from(JSON.stringify({ guid: crypto.randomUUID().replace(/-/g, '').slice(0, 20), method: 'sub', data: { mode: 'full', instrumentKeys: keys } })));
        h.onState('open');
      };
      ws.onmessage = ev => {
        if (typeof ev.data === 'string') return;
        let msg; try { msg = decode(new Uint8Array(ev.data)); } catch (e) { h.onState('decode_error', e); return; }
        if (msg.marketInfo?.segmentStatus) h.onSegments(msg.marketInfo.segmentStatus);
        const quotes = {};
        for (const [key, feed] of Object.entries(msg.feeds || {})) {
          const id = this.#idForKey(key); if (!id) continue;
          const full = feed.fullFeed?.indexFF || feed.fullFeed?.marketFF, l = feed.ltpc || full?.ltpc || feed.firstLevelWithGreeks?.ltpc;
          if (!l || !(l.ltp > 0)) continue;
          const day = full?.marketOHLC?.ohlc?.find(o => o.interval === '1d');
          quotes[id] = { price: l.ltp, prevClose: l.cp > 0 ? l.cp : null, open: day?.open > 0 ? day.open : null, high: day?.high > 0 ? day.high : null, low: day?.low > 0 ? day.low : null,
            volume: day?.vol > 0 ? day.vol : null, ts: l.ltt > 0 ? l.ltt : (msg.currentTs > 0 ? msg.currentTs : null) };
          this.instruments[id].verified = true;
        }
        if (Object.keys(quotes).length) h.onQuotes(quotes);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws !== ws) return; this.ws = null; h.onState('closed');
        this.#retry(this.backoff); this.backoff = Math.min(this.backoff * 2, 60000);
      };
    } catch (e) {
      h.onState(e.auth ? 'auth_error' : 'error', e);
      this.#retry(e.auth ? 60000 : this.backoff); this.backoff = Math.min(this.backoff * 2, 60000);
    }
  }
}
