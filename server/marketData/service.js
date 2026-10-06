/* Bullsy market-data service: the single source of truth for market data.

   Provider (Upstox) -> this service (cache + status) -> HTTP/SSE -> game.

   Rules this file enforces:
   - Every number comes from the provider. Nothing is generated or smoothed.
   - A quote is labelled LIVE only while the market is open AND the provider's
     own timestamp on it is recent AND the feed is healthy.
   - When the feed fails, the last genuine values stay visible but are marked
     UNAVAILABLE (stale); they never keep moving.
*/
import { INDICES, INDEX_IDS, INDEX_BY_ID } from './indices.js';
import { ist, istDate, inScheduledSession, shiftDate, sessionCloseMs } from './marketHours.js';

const RANGES = {
  '1D': { kind: 'intraday', minutes: 5 },
  '1W': { kind: 'minutes', minutes: 30, days: 9 },
  '1M': { kind: 'days', days: 31 },
  '3M': { kind: 'days', days: 92 },
  '6M': { kind: 'days', days: 183 },
  '1Y': { kind: 'days', days: 366 },
  'REPLAY': { kind: 'days', days: 760 }
};

export class MarketDataService {
  constructor(provider, cfg, log = console) {
    this.provider = provider; this.cfg = cfg; this.log = log;
    this.quotes = {};                 // id -> normalised quote
    this.segments = { at: 0, map: {} };
    this.feed = { transport: 'none', streamOpen: false, error: null, authError: false, lastOk: 0 };
    this.cache = new Map();           // history cache
    this.listeners = new Set();
    this.emitTimer = null; this.timers = [];
  }

  /* ---------------- lifecycle ---------------- */
  async start() {
    await this.provider.resolveInstruments().catch(e => this.log.warn('[market] instrument check failed:', e.message));
    if (this.cfg.delayDays > 0) {
      this.feed.transport = 'daily-candles';
      await this.#refreshFromDaily();
      this.timers.push(setInterval(() => this.#refreshFromDaily(), 15 * 60000));
    } else {
      await this.#refreshQuotes();
      if (this.cfg.useStream && this.provider.startStream) this.#startStream();
      this.nextPoll = 0;
      this.timers.push(setInterval(() => this.#pollTick(), 1000));
    }
    // Status labels depend on the clock (open/closed, freshness), so re-broadcast periodically.
    this.timers.push(setInterval(() => this.#emit(), 15000));
  }
  stop() { this.timers.forEach(clearInterval); this.provider.stopStream?.(); }
  /* Called after a new access token arrives (login callback). */
  async onCredentialsChanged() {
    this.feed.authError = false; this.feed.error = null; this.cache.clear();
    if (this.cfg.delayDays > 0) return this.#refreshFromDaily();
    await this.#refreshQuotes(); this.provider.restartStream?.();
  }

  /* ---------------- ingestion ---------------- */
  #merge(incoming, source) {
    const now = Date.now();
    for (const [id, q] of Object.entries(incoming)) {
      if (!INDEX_BY_ID[id] || !(q.price > 0)) continue;
      const old = this.quotes[id] || {}, next = { ...old };
      for (const k of ['price', 'prevClose', 'open', 'high', 'low', 'volume', 'ts']) if (q[k] != null) next[k] = q[k];
      next.source = source; next.receivedAt = now;
      this.quotes[id] = next;
    }
    this.#emit();
  }
  #ok(transport) { this.feed.lastOk = Date.now(); this.feed.error = null; this.feed.authError = false; this.feed.transport = transport; }
  #fail(e, where) {
    const msg = e?.message || String(e);
    if (this.feed.error !== msg) this.log.error(`[market] ${where} failed: ${msg}`);
    this.feed.error = msg; this.feed.authError = !!e?.auth;
  }

  async #refreshQuotes() {
    try {
      const q = await this.provider.fetchQuotes(INDEX_IDS);
      this.#ok(this.feed.streamOpen ? 'websocket' : 'polling'); this.#merge(q, 'rest');
      const missing = INDEX_IDS.filter(id => !q[id]);
      if (missing.length) this.log.warn('[market] no quote returned for: ' + missing.join(', '));
    } catch (e) {
      this.#fail(e, 'quote request');
      // No usable quote API (for example no token yet): show the last genuine daily close instead of nothing.
      if (INDEX_IDS.some(id => !this.quotes[id])) await this.#refreshFromDaily(true);
      this.#emit();
    }
  }

  /* Quotes built from completed daily candles. Used for the one-day-delayed mode
     and as a fallback when quotes cannot be fetched. Still genuine data. */
  async #refreshFromDaily(onlyMissing = false) {
    const today = istDate();
    let any = false;
    for (const id of INDEX_IDS) {
      if (onlyMissing && this.quotes[id]) continue;
      try {
        let candles = (await this.getIndexHistory(id, '1M', { raw: true })).candles;
        if (this.cfg.delayDays > 0) candles = candles.filter(c => istDate(c.t) < today);
        const last = candles.at(-1), prev = candles.at(-2);
        if (!last) continue;
        this.quotes[id] = { price: last.c, prevClose: prev ? prev.c : null, open: last.o, high: last.h, low: last.l, volume: last.v, ts: sessionCloseMs(istDate(last.t)), source: 'daily-candle', receivedAt: Date.now() };
        any = true;
      } catch (e) { this.#fail(e, `daily candles for ${id}`); }
    }
    if (any && this.cfg.delayDays > 0) this.#ok('daily-candles');
    this.#emit();
  }

  #startStream() {
    this.provider.startStream(INDEX_IDS, {
      onQuotes: q => { this.feed.streamOpen = true; this.#ok('websocket'); this.#merge(q, 'stream'); },
      onSegments: map => { this.segments = { at: Date.now(), map: { ...this.segments.map, ...map } }; this.#ok('websocket'); this.#emit(); },
      onState: (state, err) => {
        if (state === 'open') { this.feed.streamOpen = true; this.log.info('[market] Upstox WebSocket connected'); }
        else if (state === 'closed') { if (this.feed.streamOpen) this.log.warn('[market] Upstox WebSocket closed, will reconnect; polling meanwhile'); this.feed.streamOpen = false; }
        else { this.feed.streamOpen = false; this.#fail(err, 'WebSocket (' + state + ')'); this.#emit(); }
      }
    });
  }
  /* Controlled polling: only when the stream is not delivering, and slowly when the market is shut. */
  #pollTick() {
    const now = Date.now(); if (now < this.nextPoll) return;
    const open = this.#sessionOpen('NSE_INDEX'), haveAll = INDEX_IDS.every(id => this.quotes[id]);
    if (this.feed.streamOpen && haveAll) { this.nextPoll = now + 60000; return; }
    this.nextPoll = now + (this.feed.authError ? 60000 : open || !haveAll ? this.cfg.pollMs : 5 * 60000);
    this.#refreshQuotes();
  }

  /* ---------------- status ---------------- */
  #sessionOpen(segment) {
    const s = this.segments.map[segment];
    if (s && Date.now() - this.segments.at < 10 * 60000) return s === 'NORMAL_OPEN';
    return inScheduledSession();
  }
  #view(id) {
    const meta = INDEX_BY_ID[id], q = this.quotes[id], inst = this.provider.instruments?.[id];
    const base = { id, name: meta.name, short: meta.short, emoji: meta.emoji, group: meta.group, verified: !!inst?.verified };
    if (!q) return { ...base, status: 'UNAVAILABLE', price: null, note: this.feed.error || 'No data received for this index yet.' };
    const now = Date.now(), healthy = !this.feed.error, open = this.#sessionOpen(id === 'SENSEX' ? 'BSE_INDEX' : 'NSE_INDEX');
    const sameDay = q.ts && istDate(q.ts) === istDate(now);
    let status, note = null;
    if (this.cfg.delayDays > 0) { status = 'DELAYED'; note = `Delayed by ${this.cfg.delayDays} trading day`; }
    else if (!open) status = 'CLOSED';
    else if (!healthy) { status = 'UNAVAILABLE'; note = 'Live data interrupted. Showing the last value received.'; }
    else if (!sameDay) { status = 'CLOSED'; note = 'No trades reported today (market holiday or not yet open).'; }
    else if (now - q.ts <= this.cfg.freshMs) status = 'LIVE';
    else { status = 'DELAYED'; note = 'No recent update from the provider.'; }
    const change = q.prevClose != null ? q.price - q.prevClose : null;
    return { ...base, status, note, price: q.price, prevClose: q.prevClose ?? null, open: q.open ?? null, high: q.high ?? null, low: q.low ?? null, volume: q.volume ?? null,
      change, changePct: change != null && q.prevClose ? change / q.prevClose * 100 : null, ts: q.ts ?? null, source: q.source };
  }

  /* ---------------- public API ---------------- */
  getIndexQuote(id) { if (!INDEX_BY_ID[id]) throw new Error('Unknown index ' + id); return this.#view(id); }
  getMultipleIndexQuotes(ids = INDEX_IDS) { return Object.fromEntries(ids.filter(id => INDEX_BY_ID[id]).map(id => [id, this.#view(id)])); }
  getMarketStatus() {
    const t = ist(), open = this.#sessionOpen('NSE_INDEX'), views = INDEX_IDS.map(id => this.#view(id));
    const count = s => views.filter(v => v.status === s).length;
    const label = this.cfg.delayDays > 0 ? 'DELAYED' : count('LIVE') ? 'LIVE' : count('UNAVAILABLE') === views.length ? 'UNAVAILABLE' : count('DELAYED') ? 'DELAYED' : count('CLOSED') ? 'CLOSED' : 'UNAVAILABLE';
    return { label, sessionOpen: open, istDate: t.date, istTime: t.time, serverTime: Date.now(), delayDays: this.cfg.delayDays,
      feed: { transport: this.feed.transport, streaming: this.feed.streamOpen, error: this.feed.error, authError: this.feed.authError, lastOk: this.feed.lastOk || null } };
  }
  getInstruments() { return Object.fromEntries(INDEX_IDS.map(id => [id, { ...this.provider.instruments[id] }])); }

  /* History for charts and replay. Returns only candles the provider supplied. */
  async getIndexHistory(id, range, { raw = false } = {}) {
    if (!INDEX_BY_ID[id]) throw new Error('Unknown index ' + id);
    const spec = RANGES[range]; if (!spec) throw new Error('Unknown range ' + range);
    const today = istDate(), delayed = this.cfg.delayDays > 0 && !raw;
    const ckey = `${id}|${range}|${delayed}`, hit = this.cache.get(ckey), now = Date.now();
    const ttl = spec.kind === 'days' ? 15 * 60000 : this.#sessionOpen('NSE_INDEX') && !delayed ? 60000 : 10 * 60000;
    if (hit && now - hit.at < ttl) return hit.value;

    let candles, interval;
    if (spec.kind === 'days') {
      interval = '1d';
      candles = await this.provider.fetchCandles(id, 'days', 1, shiftDate(today, -spec.days), today);
      if (delayed) candles = candles.filter(c => istDate(c.t) < today);
    } else if (spec.kind === 'minutes') {
      interval = spec.minutes + 'm';
      candles = await this.provider.fetchCandles(id, 'minutes', spec.minutes, shiftDate(today, -spec.days), today);
      if (!delayed) candles = this.#append(candles, await this.provider.fetchIntraday(id, 'minutes', spec.minutes).catch(() => []));
      else candles = candles.filter(c => istDate(c.t) < today);
    } else {
      interval = spec.minutes + 'm';
      candles = delayed ? [] : await this.provider.fetchIntraday(id, 'minutes', spec.minutes).catch(() => []);
      if (!candles.length) {            // market shut or delayed mode: show the most recent completed session
        let past = await this.provider.fetchCandles(id, 'minutes', spec.minutes, shiftDate(today, -7), today);
        if (delayed) past = past.filter(c => istDate(c.t) < today);
        const lastDay = past.length ? istDate(past.at(-1).t) : null;
        candles = past.filter(c => istDate(c.t) === lastDay);
      }
    }
    const value = { index: id, range, interval, candles, fetchedAt: now, sessionDate: candles.length ? istDate(candles.at(-1).t) : null };
    this.cache.set(ckey, { at: now, value });
    return value;
  }
  #append(a, b) { const seen = new Set(a.map(c => c.t)); return a.concat(b.filter(c => !seen.has(c.t))).sort((x, y) => x.t - y.t); }

  /* Subscribe to updates. cb receives { quotes, market }. Returns an unsubscribe function. */
  subscribeToMarketUpdates(ids, cb) {
    const entry = { ids: ids && ids.length ? ids : INDEX_IDS, cb };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
  snapshot(ids) { return { quotes: this.getMultipleIndexQuotes(ids), market: this.getMarketStatus() }; }
  /* At most one broadcast per second, however fast ticks arrive. */
  #emit() {
    if (this.emitTimer || !this.listeners.size) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      for (const l of this.listeners) { try { l.cb(this.snapshot(l.ids)); } catch (e) { this.log.warn('[market] listener error', e.message); } }
    }, 1000);
  }
}
export { INDICES };
