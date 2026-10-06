/* The owner-only status page at /admin. Rendered on the server; contains no secrets. */
import { INDICES } from './marketData/indices.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const istWhen = ms => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'never');

export function adminPage({ config, provider, market, csrf, note }) {
  const m = market.getMarketStatus(), q = market.getMultipleIndexQuotes(), inst = market.getInstruments(), auth = provider.authInfo(), angel = provider.name === 'angelone';
  const tok = angel ? { present: auth.loggedIn } : provider.tokenInfo(), name = esc(provider.label);
  const realTime = config.delayDays === 0;
  const connected = angel ? auth.loggedIn && !m.feed.error && !!m.feed.lastOk : realTime ? tok.present && !m.feed.authError && !!m.feed.lastOk : !m.feed.error;
  const rows = INDICES.map(i => { const v = q[i.id];
    return `<tr><td>${esc(i.name)}</td><td><span class="s ${v.status}">${v.status === 'CLOSED' ? 'MARKET CLOSED' : v.status}</span></td><td class="n">${v.price != null ? v.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'no data'}</td><td>${esc(istWhen(v.ts))}</td><td><code>${esc(inst[i.id].key)}</code> ${inst[i.id].verified ? 'verified' : '<b class="bad">not verified</b>'}</td></tr>`; }).join('');
  const msg = note === 'saved' ? '<p class="ok">Token saved.</p>' : note === 'empty' ? '<p class="bad">That does not look like a token.</p>' : note === 'signedin' ? '<p class="ok">Signed in to Angel One.</p>' : note === 'signinfailed' ? '<p class="bad">Sign-in failed. The reason is shown below.</p>' : '';
  const angelBox = `<p>Sign-in: <b>automatic</b>. The server signs in to Angel One by itself with your client code, PIN and a one-time code made from the TOTP secret, and signs in again whenever the session ends. Nothing needs doing each day.</p>
<p>Status: ${!auth.configured ? '<b class="bad">not configured</b>. Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and ANGEL_TOTP_SECRET on the server.' : auth.loggedIn ? 'signed in since ' + esc(istWhen(auth.lastLoginAt)) : '<b class="bad">not signed in</b>'}${auth.lastError ? `<br><span class="bad">Last sign-in error: ${esc(auth.lastError)}</span>` : ''}</p>
<form method="post" action="/admin/relogin"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Sign in again now</button></form>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="30">
<title>Bullsy admin</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#120E33;color:#FFF6E5;line-height:1.5}
main{max-width:920px;margin:0 auto;padding:24px 16px 60px} h1{color:#FFB627;margin:0 0 4px} h2{margin:28px 0 8px;font-size:1.15rem}
.card{background:#261F5C;border:2px solid #463C9C;border-radius:16px;padding:16px;margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:.92rem} td,th{padding:8px 6px;border-bottom:1px solid #463C9C;text-align:left} .n{font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto} code{font-size:.82rem;color:#BDB6E6} .muted{color:#BDB6E6} .ok{color:#2EE6A6} .bad{color:#FF6B81}
.big{font-size:1.4rem;font-weight:800} .s{font-weight:700;font-size:.8rem;border:1px solid;border-radius:99px;padding:2px 9px;white-space:nowrap}
.LIVE{color:#2EE6A6}.DELAYED{color:#FFB627}.CLOSED,.UNAVAILABLE{color:#FF6B81}
a.btn,button{display:inline-block;background:#FFB627;color:#120E33;font-weight:700;border:0;border-radius:12px;padding:10px 16px;text-decoration:none;font:inherit;font-weight:700;cursor:pointer}
input[type=password]{width:100%;max-width:520px;padding:10px;border-radius:10px;border:2px solid #463C9C;background:#120E33;color:#FFF6E5;font:inherit;margin:6px 0 10px}
</style></head><body><main>
<h1>Bullsy admin</h1><p class="muted">Only you can see this page. It refreshes every 30 seconds. Server time ${esc(m.istDate)} ${esc(m.istTime)} IST.</p>
${msg}
<div class="card"><p class="big">${name} connection: <span class="${connected ? 'ok' : 'bad'}">${connected ? 'CONNECTED' : 'DISCONNECTED'}</span></p>
<p>Data mode: <b>${realTime ? 'Real time' : `Delayed by ${config.delayDays} trading day`}</b>. Players see: <b>${esc(m.label === 'CLOSED' ? 'MARKET CLOSED' : m.label)}</b>. Transport: ${esc(m.feed.transport)}${m.feed.streaming ? ' (streaming)' : ''}. Last successful update: ${esc(istWhen(m.feed.lastOk))}.</p>
${m.feed.error ? `<p class="bad">Last error: ${esc(m.feed.error)}</p>` : ''}
${angel ? angelBox : realTime ? `<p>Access token: ${tok.present ? `present${tok.savedAt ? ', saved ' + esc(istWhen(Date.parse(tok.savedAt))) : ' (from the UPSTOX_ACCESS_TOKEN setting)'}` : '<b class="bad">none</b>'}. Upstox tokens stop working at 3:30 AM IST every day and Upstox does not allow renewing them automatically, so this must be done by you each trading day.</p>
<p><a class="btn" href="/admin/upstox/login">Connect Upstox / renew today's token</a></p>
<details><summary>Or paste a token</summary><form method="post" action="/admin/token"><input type="hidden" name="csrf" value="${esc(csrf)}"><label>Access token generated in the Upstox developer console<br><input type="password" name="token" autocomplete="off"></label><br><button>Save token</button></form></details>`
: `<p class="muted">In delayed mode Bullsy uses only completed daily and intraday candles, which Upstox serves without a login, so there is nothing to renew each day. To switch to real time, set BULLSY_DATA_DELAY_DAYS=0 on the server (read the README section on real-time data first).</p>`}
</div>
<h2>Indices</h2><div class="card wrap"><table><tr><th>Index</th><th>Status</th><th>Value</th><th>Data time</th><th>${name} instrument</th></tr>${rows}</table></div>
<h2>Settings in effect</h2><div class="card"><p>Allowed frontend sites: ${config.frontendOrigins.length ? config.frontendOrigins.map(esc).join(', ') : 'this site only'}<br>Provider: ${name} (MARKET_DATA_PROVIDER=${esc(config.provider)})${angel ? '' : `<br>Upstox redirect URL (must match your Upstox app exactly): <code>${esc(config.upstox.redirectUri)}</code>`}<br>AI Coach: ${config.anthropicKey ? 'on' : 'off (no ANTHROPIC_API_KEY)'}</p></div>
</main></body></html>`;
}
