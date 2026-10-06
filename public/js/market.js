/* Bullsy frontend market-data client.
   Every screen (Market Pulse, charts, 3D market, trading, missions, scoring,
   AI coach) reads prices from here and nowhere else.

   Two sources, one interface:
     LIVE   - quotes pushed by the Bullsy server (which gets them from the provider)
     REPLAY - real historical daily candles from the same server, stepped by the game

   Nothing in this file creates, smooths or estimates a price. */
const Market = (() => {
  const st = { cfg: null, mode: 'live', quotes: {}, market: null, connected: false, error: null, replay: null };
  const subs = new Set(), histCache = new Map();
  let es = null;
  /* Address of the Bullsy backend. Empty means "same site". Set in public/config.js. */
  const API = String(window.BULLSY_API_BASE || '').replace(/\/$/, '');
  const notify = what => subs.forEach(fn => { try { fn(what); } catch (e) { console.error(e); } });
  const istDay = ms => new Date(ms + 19800000).toISOString().slice(0, 10);

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store' }), body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && (body.detail || body.error)) || 'Market data temporarily unavailable');
    return body;
  }
  async function init() {
    st.cfg = await getJSON(API + '/api/market/config');
    connectLive();
    return st.cfg;
  }

  /* ---------------- live ---------------- */
  function connectLive() {
    if (es) return;
    es = new EventSource(API + '/api/market/stream');
    es.onmessage = ev => {
      const data = JSON.parse(ev.data);
      st.quotes = data.quotes; st.market = data.market; st.connected = true; st.error = null;
      notify(st.mode === 'live' ? 'quotes' : 'status');
    };
    es.onerror = () => { st.connected = false; st.error = 'Connection to the Bullsy server lost. Reconnecting.'; notify('status'); };
  }
  function useLive() { st.mode = 'live'; st.replay = null; notify('mode'); }

  /* ---------------- replay ---------------- */
  /* Loads real daily candles for all 8 indices and keeps only the trading days
     that every available index has, so all indices move on the same real days. */
  async function loadReplay() {
    const ids = st.cfg.indices.map(i => i.id), series = {}, failed = [];
    await Promise.all(ids.map(async id => {
      try { const h = await getJSON(`${API}/api/market/history/${id}?range=REPLAY`); if (h.candles.length < 30) throw new Error('too little history'); series[id] = new Map(h.candles.map(c => [istDay(c.t), c])); }
      catch (e) { failed.push(id); }
    }));
    if (!series.NIFTY50) throw new Error('Historical data for NIFTY 50 is unavailable, so replay cannot start.');
    let dates = [...series.NIFTY50.keys()];
    for (const id of Object.keys(series)) dates = dates.filter(d => series[id].has(d));
    dates.sort();
    if (dates.length < 30) throw new Error('Not enough historical data for a replay.');
    return { series, dates, failed, cursor: dates.length - 1, start: dates.length - 1 };
  }
  function useReplay(rp, startIndex) { rp.cursor = rp.start = startIndex; st.replay = rp; st.mode = 'replay'; notify('mode'); }
  function step(n) { const r = st.replay; if (!r || r.cursor + n > r.dates.length - 1) return false; r.cursor += n; notify('quotes'); return true; }

  function replayQuote(id) {
    const r = st.replay, meta = st.cfg.indices.find(i => i.id === id), s = r.series[id];
    if (!s) return { ...meta, status: 'UNAVAILABLE', price: null, note: 'No historical data for this index.' };
    const c = s.get(r.dates[r.cursor]), p = r.cursor > 0 ? s.get(r.dates[r.cursor - 1]) : null;
    const change = p ? c.c - p.c : null;
    return { ...meta, status: 'REPLAY', price: c.c, prevClose: p ? p.c : null, open: c.o, high: c.h, low: c.l, volume: c.v, change, changePct: p ? change / p.c * 100 : null,
      ts: Date.parse(r.dates[r.cursor] + 'T15:30:00+05:30'), date: r.dates[r.cursor] };
  }

  /* ---------------- shared interface ---------------- */
  function quote(id) {
    if (st.mode === 'replay' && st.replay) return replayQuote(id);
    const meta = st.cfg.indices.find(i => i.id === id), q = st.quotes[id];
    if (!q) return { ...meta, status: 'UNAVAILABLE', price: null };
    /* If the browser has lost the server, whatever we still hold is no longer current. */
    return st.connected ? q : { ...q, status: 'UNAVAILABLE', note: 'Connection lost. Showing the last value received.' };
  }
  const price = id => { const q = quote(id); return q && q.price > 0 ? q.price : null; };
  /* Trading needs a genuine current price: not allowed on UNAVAILABLE data. */
  const tradable = id => { const q = quote(id); return q.price > 0 && q.status !== 'UNAVAILABLE'; };
  const replayDate = () => (st.replay ? st.replay.dates[st.replay.cursor] : null);

  const SESSIONS = { '1W': 5, '1M': 21, '3M': 63, '6M': 126, '1Y': 252 };
  /* Chart history. In replay, candles stop at the replay date (no peeking ahead). */
  async function history(id, range) {
    if (st.mode === 'replay' && st.replay) {
      const r = st.replay, s = r.series[id], n = SESSIONS[range];
      if (!s || !n || r.cursor + 1 < n) return { index: id, range, interval: '1d', candles: [] };
      return { index: id, range, interval: '1d', candles: r.dates.slice(r.cursor + 1 - n, r.cursor + 1).map(d => s.get(d)) };
    }
    const key = id + '|' + range, hit = histCache.get(key), ttl = range === '1D' || range === '1W' ? 60000 : 600000;
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await getJSON(`${API}/api/market/history/${id}?range=${range}`);
    histCache.set(key, { at: Date.now(), value });
    return value;
  }
  const ranges = () => (st.mode === 'replay' ? ['1W', '1M', '3M', '6M', '1Y'] : st.cfg.ranges);
  /* Recent real closes for the small card charts. */
  function spark(id) {
    if (st.mode === 'replay' && st.replay) { const r = st.replay, s = r.series[id]; return s ? r.dates.slice(Math.max(0, r.cursor - 19), r.cursor + 1).map(d => s.get(d).c) : []; }
    const hit = histCache.get(id + '|1D');
    if (!hit) { if (!histCache.has(id + '|pending')) { histCache.set(id + '|pending', 1); history(id, '1D').then(() => notify('spark')).catch(() => {}).finally(() => setTimeout(() => histCache.delete(id + '|pending'), 30000)); } return []; }
    return hit.value.candles.map(c => c.c);
  }

  /* Overall data label shown in the banner. Never says LIVE unless a quote is LIVE. */
  function label() {
    if (st.mode === 'replay') return { key: 'REPLAY', emoji: '🔵', text: 'HISTORICAL MARKET REPLAY' };
    const all = { LIVE: { key: 'LIVE', emoji: '🟢', text: 'LIVE MARKET DATA' }, DELAYED: { key: 'DELAYED', emoji: '🟡', text: 'DELAYED MARKET DATA' },
      CLOSED: { key: 'CLOSED', emoji: '🔴', text: 'MARKET CLOSED' }, UNAVAILABLE: { key: 'UNAVAILABLE', emoji: '⚠️', text: 'MARKET DATA UNAVAILABLE' } };
    return all[st.connected && st.market ? st.market.label : 'UNAVAILABLE'];
  }

  return { api: API, init, state: st, on: fn => { subs.add(fn); return () => subs.delete(fn); }, useLive, loadReplay, useReplay, step, quote, price, tradable, replayDate, history, ranges, spark, label, istDay };
})();
