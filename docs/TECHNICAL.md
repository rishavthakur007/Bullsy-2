# Bullsy technical notes (for developers)

Deployment steps are in the main README. This file explains how the data layer works.

Bullsy is a stock-market learning game played with pretend money. This version
replaces the old 15-stock dataset and the random price engine with **real data
for 8 Indian indices from the Upstox API**. No price in the game is generated,
randomised or estimated.

NIFTY 50, SENSEX, NIFTY BANK, NIFTY IT, NIFTY AUTO, NIFTY FINANCIAL SERVICES,
NIFTY FMCG, NIFTY PHARMA.

## Status of this code: read first

- Tested here: 47 backend checks and 14 browser checks (`npm test`,
  `node test/e2e.js`) against a **test double** of the Upstox API, because the
  build environment had no internet access and no Upstox credentials.
- **Not yet tested against the real Upstox API.** After deploying, confirm it on the `/admin` page (main README, step 7).
- Not visually tested here: the 3D scene and the TradingView Lightweight Charts
  drawing (both load from CDNs the build environment could not reach).

## Running it yourself (developers only)

Players never do this. For local development: Node.js 22+, copy `.env.example` to `.env`, then `npm start`. The optional `npm run check` script tests a real Upstox connection from the command line; the `/admin` page shows the same information on the deployed site.

## Environment variables

| Variable | Purpose |
|---|---|
| `UPSTOX_CLIENT_ID`, `UPSTOX_CLIENT_SECRET` | Upstox app key and secret |
| `UPSTOX_REDIRECT_URI` | Must match the app's redirect URL |
| `UPSTOX_ACCESS_TOKEN` | Optional: paste today's token instead of using the login link |
| `ADMIN_PASSWORD` | Password for /admin |
| `PUBLIC_BACKEND_URL`, `FRONTEND_ORIGIN` | Backend address; frontend site allowed to call the API |
| `BULLSY_DATA_DELAY_DAYS` | `1` (default) one trading day late, `0` real time |
| `BULLSY_USE_WEBSOCKET` | `false` to poll only |
| `BULLSY_POLL_INTERVAL_MS` | Poll interval when the WebSocket is down (default 5000) |
| `UPSTOX_KEY_<ID>` | Override one instrument key, e.g. `UPSTOX_KEY_NIFTYIT` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional AI Coach |
| `PORT` | Server port |

All of these are read only by the server. Nothing secret is sent to the browser.

## Using real-time data: check this before going public

SEBI's circular of 24 May 2024 ("Norms for sharing of real time price data to
third parties") restricts brokers and exchanges from sharing real-time prices
with virtual-trading and fantasy-game platforms. It allows price data for
investor education with **a one-day lag and no monetary incentives**. Broker
API data is also normally licensed to the account holder.

- For a private demo on your own machine, real time (`BULLSY_DATA_DELAY_DAYS=0`)
  shows what the system can do.
- For anything other people use, set `BULLSY_DATA_DELAY_DAYS=1`. Bullsy then
  never requests real-time data, labels everything DELAYED, and switches live
  rounds off. Historical replay is unaffected.

This is not legal advice; confirm with Upstox and your institution.

## Architecture

```
Upstox API
   |  server/marketData/providers/upstox.js   only file with Upstox keys, URLs, formats
   v
server/marketData/service.js                  cache, status labels, history ranges
   |  server/index.js                         /api/market/quotes  /api/market/history/:index  /api/market/stream (SSE)
   v
public/js/market.js                           the one place the game reads prices from
   v
public/js/game.js                             Market Pulse, charts, trading, rounds, missions, scoring, coach
public/js/world3d.js                          3D towers sized from real % change
```

Service functions: `getIndexQuote(id)`, `getMultipleIndexQuotes(ids)`,
`getIndexHistory(id, range)`, `getMarketStatus()`,
`subscribeToMarketUpdates(ids, callback)`.

To change provider, write another file with the same methods as
`providers/upstox.js` and construct it in `server/index.js`.

### Upstox endpoints used

| Purpose | Endpoint |
|---|---|
| Snapshot quotes (8 keys in one call) | `GET /v2/market-quote/quotes` |
| Historical candles | `GET /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}` |
| Today's candles | `GET /v3/historical-candle/intraday/{key}/{unit}/{interval}` |
| WebSocket address | `GET /v3/feed/market-data-feed/authorize` |
| Live ticks | Market Data Feed V3 WebSocket, protobuf, `full` mode |
| Login | `/v2/login/authorization/dialog`, `/v2/login/authorization/token` |
| Key verification | `assets.upstox.com/.../NSE.json.gz`, `BSE.json.gz` |

### Instrument keys

| Index | Key | Confirmed from Upstox sources |
|---|---|---|
| NIFTY 50 | `NSE_INDEX|Nifty 50` | yes |
| NIFTY BANK | `NSE_INDEX|Nifty Bank` | yes |
| NIFTY FINANCIAL SERVICES | `NSE_INDEX|Nifty Fin Service` | yes |
| SENSEX | `BSE_INDEX|SENSEX` | no, expected |
| NIFTY IT | `NSE_INDEX|Nifty IT` | no, expected |
| NIFTY AUTO | `NSE_INDEX|Nifty Auto` | no, expected |
| NIFTY FMCG | `NSE_INDEX|Nifty FMCG` | no, expected |
| NIFTY PHARMA | `NSE_INDEX|Nifty Pharma` | no, expected |

At startup the server checks all 8 against Upstox's instrument list, matches by
name if a key differs, and prints `verified` or `UNVERIFIED` for each. An
unresolved index shows DATA UNAVAILABLE; its value is never guessed.
`npm run find-keys -- pharma` lists candidates.

## How real-time updates work

1. The server asks Upstox for a WebSocket address and subscribes to the 8 keys.
2. Each tick is decoded and stored in the service with Upstox's own timestamp.
3. The service pushes at most one update per second to browsers over
   Server-Sent Events. Browsers never contact Upstox.
4. If the WebSocket is down, the server polls the quote endpoint: one request
   for all 8 indices every 5 s in market hours, every 5 min otherwise, once a
   minute after an auth failure. Upstox's limit is 2000 requests per 30 min.
5. Reconnects back off from 1 s to 60 s.

Status labels:

- **LIVE**: market open, feed healthy, quote timestamp under 2 minutes old.
- **DELAYED**: delay mode, or market open but no recent update.
- **MARKET CLOSED**: outside 9:15 to 15:30 IST Monday to Friday, or Upstox
  reports the segment closed, or a weekday with no trades dated today (holiday).
- **DATA UNAVAILABLE**: no data, or the feed failed. The last real value stays
  visible, marked not current, and does not move.

## How the game uses the data

- **Historical replay** loads about two years of real daily candles, keeps the
  days all indices share, and plays 8 rounds of 1, 5 or 21 real trading days.
  Charts never show dates beyond the current replay day. "Surprise me" picks
  which real period to play; that is the only random choice touching the market.
- **Live market** rounds last 1, 5 or 15 real minutes and settle on the genuine
  prices at the start and end. They cannot start unless data is LIVE.
- Positions are opened by rupee amount. Long P&L = (current - entry) x units.
  Short P&L = (entry - current) x units.
- Sector Race ranks the six sector indices by real move each round.
- The benchmark is the same money held in NIFTY 50 over the same real period.
- 3D tower height = real % change (today's change in live mode, change since
  the game started in replay). Clouds, coins and mascots are decoration only.
- The coach review and AI Coach receive the real trade log and real index moves.

Removed: the 15-stock dataset, the random price engine, invented news, the
analyst hint that explained invented news (now a "Trend scan" of real recent
moves), stock risk labels and the old Nifty CSV replay panel.

## Known limitations

- Exchange holidays are inferred from the data, not from a calendar.
- A game is not saved if the page is reloaded.
- Index volume is usually not supplied; Bullsy shows it only when present.
- In live mode with the market shut, positions can be opened at the last real
  price but rounds cannot run.
- The AI Coach needs `ANTHROPIC_API_KEY`; without it the built-in review shows.
- Charts load TradingView Lightweight Charts (drawing only) from a CDN; if it
  fails, a simple line of the same real closes is shown.

## Testing

```
npm test                 # backend, against the test double in test/mock-upstox.js
node test/e2e.js         # browser playthrough (needs Playwright installed)
npm run check            # your real Upstox connection
```

`test/mock-upstox.js` is used only by these tests. The server reaches it only
when a test sets `UPSTOX_API_BASE`; it contains fixed fixture numbers, not
market data.
