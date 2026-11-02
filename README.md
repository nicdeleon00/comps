# Comps

A self-hosted card price platform and a companion iPhone app.

- **Deals** — finds cards priced under what they're worth: live eBay Buy It Now listings below fair value, price dips against 30-day history, lowball asks, cross-market gaps (TCGplayer vs Cardmarket), and US prices lagging a rising EU market.
- **Raw to Graded** — finds cards that are cheap raw but sell for a multiple once slabbed. For each one it computes expected profit after grading and selling fees, and the **break-even gem rate**: the share of PSA 10s you need to not lose money.
- **Collection** — your cards, valued by grade and condition, with a value-over-time chart. Syncs with the app.
- **iPhone app** — scans cards with the camera, one at a time or **continuously** (flip through a stack and it reads each new card), tracks your collection, and shows deals.

Pokémon, Magic: The Gathering, Yu-Gi-Oh! and (with PriceCharting) sports cards.

---

## Run the server and website

Requires Node 22.13+ (built-in SQLite, no database to install).

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:8787. The first refresh starts a few seconds after launch and downloads the Pokémon, Magic and Yu-Gi-Oh! catalogs with prices. Without a Pokémon TCG API key that takes a few minutes because of their rate limit. Prices refresh every 12 hours.

To look around with generated sample data first (clearly labelled "Sample data" in the UI, nothing real):

```bash
npm run demo
```

For development with hot reload, run `npm start` in one terminal and `npm run dev` in another, then open http://localhost:5173.

### Docker

```bash
docker build -t comps .
```

```bash
docker run -d -p 8787:8787 -v comps-data:/data --name comps comps
```

### API keys — what each one unlocks

Add them in **Settings** on the website (or as environment variables).

| Key | Cost | Unlocks |
|---|---|---|
| none | free | Raw prices for every Pokémon card, Magic printings over $2, Yu-Gi-Oh! printings over $2. Low-ask, cross-market, momentum and dip signals. Collection, scanning. |
| **PriceCharting** (`PRICECHARTING_TOKEN`) | paid subscription | Graded prices (grade 7, 8, 9, 9.5, PSA 10, BGS 10, CGC 10, SGC 10) and sports cards. This powers **Raw to Graded**. |
| **eBay developer keyset** (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`) | free | Live listing scanner: checks your watchlist, the best grading spreads and high-value cards every 3 hours and flags clean listings under value. |
| Pokémon TCG API (`POKEMONTCG_API_KEY`) | free | Faster first download (higher rate limit). |

Other environment variables: `PORT` (8787), `DATA_DIR` (`./data`), `COMPS_TOKEN` (require a bearer token for the API — set this if the server is reachable from the internet), `REFRESH_HOURS`, `PUBLIC_URL` (address shown on the pairing screen).

---

## How the numbers work

**Fair value.** Every source's quote for a card printing (TCGplayer market, Scryfall, YGOPRODeck, PriceCharting ungraded, Cardmarket trend converted at the ECB rate) is combined into one value. Outliers more than 2.5× from the median are dropped, the rest are weighted by how much each source reflects US near-mint sales. Confidence reflects how many sources agree and, for PriceCharting, how often the card sells.

**Deal score (0–100).** Half discount depth, a quarter dollar upside (log scale, so a $300 gap beats a $3 one), a quarter confidence, then weighted by signal type — a live listing you can buy right now counts more than a model signal. Listings are filtered hard: proxies, lots, wrong language, wrong printing (1st edition, shadowless, reverse holo, foil), damaged copies and unknown graders are thrown out, and the collector number has to match.

**Raw to graded.** For each card with a PSA 10 price:

- cost = raw price + grading fee + shipping
- each outcome (10, 9, 8, 7 or lower) nets its sale price minus selling fees
- expected value = Σ probability × net, using gem rates for the card's era (vintage ≤2002, 2003–2016, modern) unless you set your own for that card
- **break-even** = the P(10) where expected value equals cost, holding the shape of the other outcomes fixed

The era gem rates are rough starting points. Break-even doesn't depend on them, which is why it's shown next to every number. If you know a card's population report, set its rates on the card page and they're used everywhere.

---

## iPhone app

SwiftUI, iOS 17+. Works on its own (scanning, raw prices for Pokémon / Magic / Yu-Gi-Oh! straight from the public APIs) and does more when connected to your server (graded prices, history, deals, sync with the website).

**Scanning.** Point the camera at a card. It finds the card's outline, waits until it's steady, flattens it, and reads the printed identifiers — the collector number and set size on Pokémon cards (`025/198`), the set code on Yu-Gi-Oh! (`LOB-EN001`), set and collector number on Magic — then looks the card up. Slab labels are read too (`GEM MT 10` → PSA 10).

- **Continuous mode:** keep feeding cards. Each new card lands in the tray with a haptic tick. A fingerprint of the card face stops it re-scanning the card that's still sitting there, so you can flip through a stack without lifting anything. Matches below your confidence threshold are marked **?** for review.
- **Single mode:** tap the shutter, confirm the match, add.

### Install it on your iPhone (sideload)

**Option A — GitHub Actions builds the IPA for you (no Mac needed).**

1. Push this project to a GitHub repository.
2. The **iOS app** workflow builds an unsigned `Comps.ipa` on a Mac runner and publishes it as the `ios-latest` release (also kept as a run artifact).
3. Install it with [Sideloadly](https://sideloadly.io), [AltStore](https://altstore.io) or [SideStore](https://sidestore.io). They sign it with your Apple ID.
4. To get updates automatically, add the source in AltStore/SideStore:
   `https://github.com/<you>/<repo>/releases/download/ios-latest/altstore-source.json`

With a free Apple ID, apps expire after 7 days; AltStore and SideStore refresh them in the background.

**Option B — Xcode (Mac).** Open `ios/Comps.xcodeproj` in Xcode 16 or later, select the Comps target → Signing & Capabilities → choose your team, change the bundle identifier if Xcode asks (e.g. `com.yourname.comps`), plug in your phone and press Run.

### Connect the app to your server

On the website open **Settings → iPhone app**. It shows your server's address on your network and a QR code. In the app: **Collection → gear icon → Scan pairing code**, or point the iPhone Camera app at the code. Your phone and server need to be on the same network — or use something like Tailscale to reach it from anywhere.

---

## Project layout

```
server/            Node server, no runtime dependencies
  src/providers/   Pokémon TCG API, Scryfall, YGOPRODeck, PriceCharting, eBay, FX
  src/engine/      valuation, deal signals, grading EV, listing filter, scan matching
  src/api.js       JSON API used by the website and the app
  test/            node --test
web/               Preact + Vite website (~30 KB gzipped JS)
ios/               SwiftUI app (Xcode project, no third-party packages)
.github/workflows  IPA build + release, server tests
```

Data notes: Pokémon TCG API, Scryfall and YGOPRODeck are free community APIs — be gentle with them (the server rate-limits itself and caches card images locally). PriceCharting and eBay data are subject to their terms. Prices are estimates; check sold listings before you spend real money.
