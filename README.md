# Bullsy: put it online with Render Free

When you finish these steps you will have one public link, such as
`https://bullsy.onrender.com`. Anyone who opens it can play straight away.
Players never install anything, log in, or see a key.

That one Render service is both the game and its server.

**Honest status:** the code passes its automated tests, but it has not been
deployed or run against the real Upstox service yet. Part 4 is how you confirm
it works. If part 4 shows a problem, send me exactly what you see.

You need: a GitHub account and a Render account (both free). No Upstox account
is needed for the default setup.

## Part 1. Put the project on GitHub

1. Unzip `bullsy-deployable.zip`. Inside are the project files: `server`, `public`,
   `package.json`, `render.yaml` and a few others.
2. On github.com click **+** (top right), **New repository**. Name it
   `bullsy`, choose **Private**, click **Create repository**.
3. On the new repository page click **uploading an existing file**.
4. Open the unzipped folder on your computer, select **everything inside it**
   (`server`, `public`, `package.json`, `render.yaml` and the rest) and drag it
   into the browser. `render.yaml` and `package.json` must end up at the top
   level of the repository, not inside another folder.
5. Click **Commit changes**.

Files whose names start with a dot (`.gitignore`, `.node-version`,
`.env.example`) may be hidden on your computer. The site works without them.
Do **not** create or upload a file named `.env`.

## Part 2. Create the site on Render

1. On dashboard.render.com click **New**, then **Blueprint**.
2. Connect your GitHub account if asked, and pick the `bullsy` repository.
3. Render reads `render.yaml` and shows one service called **bullsy** on the
   **Free** plan. It asks for one value:
   - `ADMIN_PASSWORD`: type a long password that only you know. Save it
     somewhere; it opens your private admin page.
4. Click **Apply** (or **Deploy Blueprint**). Wait a few minutes until the
   service shows **Live**.
5. At the top of the service page Render shows your public link, ending in
   `.onrender.com`. **That link is the game.** If the name `bullsy` was taken,
   Render adds a few letters to it.

If Render does not offer Blueprint, choose **New**, **Web Service** instead and
enter: Language **Node**, Build Command `echo 'no build step'`, Start Command
`node server/index.js`, Instance Type **Free**, Health Check Path
`/api/health`, plus the variables in part 3.

## Part 3. Environment variables

They live only in Render: service page, **Environment**. Never in GitHub.

Set by `render.yaml` for you:

| Variable | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `BULLSY_DATA_DELAY_DAYS` | `1` |
| `ADMIN_PASSWORD` | the password you typed |

`PUBLIC_BACKEND_URL` is **not needed on Render**: the server reads the address
Render assigns by itself. Set it only if you later add your own domain.

Optional, add only if you want the feature:

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Shows the "Ask the AI coach" button. Each use costs you money; the server limits it to 5 per visitor per hour. |
| `UPSTOX_CLIENT_ID`, `UPSTOX_CLIENT_SECRET` | Only for real-time mode later. See `docs/TECHNICAL.md`. |

After changing a variable, Render redeploys by itself.

## Part 4. Check that it works

1. Open `https://<your-link>/api/health`. You should see `"ok":true`.
2. Open `https://<your-link>/admin`. The browser asks for a username and
   password: type anything as the username and your `ADMIN_PASSWORD`.
   - **Upstox connection: CONNECTED** and all 8 indices showing **DELAYED**
     with a value means the real data is arriving.
   - **DISCONNECTED** or **UNAVAILABLE** means it is not. Copy the "Last
     error" line and send it to me. The game will show DATA UNAVAILABLE to
     players; it never makes prices up.
3. Open `https://<your-link>/` in a private window. You should see the 3D
   market, the yellow DELAYED banner and 8 Market Pulse cards with values.
4. Click **Enter the market**, tap an index, go long or short, and play the 8
   rounds. You should finish on a report card.
5. Share the link.

## What to expect on the free plan

- **It sleeps.** After about 15 minutes with no visitors Render stops the
  service. The next visitor waits up to a minute while it wakes; after that it
  is fast. Render's paid Starter plan removes this.
- **Nothing is saved between restarts.** That is fine here: delayed mode needs
  no stored token.
- **Updating the game:** upload changed files to GitHub; Render redeploys.

## What players see, and what they never see

They see the game: Market Pulse for NIFTY 50, SENSEX, NIFTY BANK, NIFTY IT,
NIFTY AUTO, NIFTY FINANCIAL SERVICES, NIFTY FMCG and NIFTY PHARMA, historical
replay, long and short trading, P&L, XP, missions, Sector Race, the 3D market,
Bullsy and the bear, and charts.

Prices are real data shown one trading day late and labelled DELAYED. If data
is missing the game says DATA UNAVAILABLE.

They never see keys, logins, setup steps or server error text. `/admin` is
password protected and is only for you.

## Using Angel One instead of Upstox

Bullsy can take its data from Angel One SmartAPI. The game itself does not change.

In Render, service page, **Environment**, add:

| Variable | Value |
|---|---|
| `MARKET_DATA_PROVIDER` | `angelone` |
| `ANGEL_API_KEY` | the API key of your SmartAPI app |
| `ANGEL_CLIENT_CODE` | your Angel One client code (login ID) |
| `ANGEL_PIN` | your Angel One login PIN |
| `ANGEL_TOTP_SECRET` | the key shown under the QR code when you enabled TOTP |
| `ADMIN_PASSWORD` | so you can open `/admin` and see whether sign-in works |

Then open `/admin`. It should say **Angel One SmartAPI connection: CONNECTED**. If
it says DISCONNECTED, the page shows Angel One's own reason.

What is different from Upstox:

- **Sign-in is automatic.** The server makes the one-time code itself and signs in
  again whenever the session ends. There is no daily step for you.
- **The server holds a full login** to the Angel One account (client code, PIN and
  TOTP secret). With Upstox in delayed mode it held nothing. Use an account you are
  comfortable exposing this way, and never put these values in GitHub or in chat.
- **Every request needs that login**, including history, so if sign-in fails the
  site shows DATA UNAVAILABLE.
- **Real-time mode polls** Angel's quote service every 5 seconds; Angel's streaming
  feed is not used.
- **Static IP:** Angel One apps can be tied to registered IP addresses. Render's
  servers do not call from your home address. If Angel One refuses the sign-in for
  that reason, `/admin` will show it.

To go back, set `MARKET_DATA_PROVIDER=upstox` (or delete the variable).

## Later: real-time mode

It is built in but switched off. It needs an Upstox app, you signing in at
`/admin` every trading day (Upstox tokens expire at 3:30 AM IST and cannot be
renewed automatically), and it raises a rules question for public games (SEBI's
May 2024 circular allows price data for education with a one-day lag). Read
`docs/TECHNICAL.md` and get written confirmation from Upstox before turning it
on.

Even in delayed mode, ask Upstox in writing whether their data may be shown to
anonymous visitors of a public site. This is not legal advice.
# Bullsy-2
