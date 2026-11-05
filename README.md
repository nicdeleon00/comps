# Comps — Pokémon card prices, deals and a scanner app

**Website:** https://nicdeleon00.github.io/comps/
**iPhone app:** [Comps.ipa](https://github.com/nicdeleon00/comps/releases/download/ios-latest/Comps.ipa) (sideload) · AltStore source: `https://github.com/nicdeleon00/comps/releases/download/ios-latest/altstore-source.json`

Everything runs on GitHub — nothing to host or keep running on your computer:

- Every 6 hours a GitHub Action downloads prices for **every English Pokémon card** (TCGplayer via [TCGCSV](https://tcgcsv.com), Cardmarket via [TCGdex](https://tcgdex.dev)), finds deals and grading spreads, saves price history, and publishes the website to GitHub Pages.
- The iPhone app reads the same published data and keeps a copy of the whole catalog on the phone, so scanning, search and your collection's value work offline.

## What it does

- **Deals** — cards priced under what they're worth: live eBay Buy It Now listings under fair value, price dips against 30-day history, TCGplayer asks 20–40% under market, and modern cards cheaper on Cardmarket than in the US.
- **Facebook Marketplace** (Deals → Marketplace) — card listings from Facebook Marketplace with what they're worth and a **Buy** link to each. They come from the free Comps extension for Chrome/Edge: it puts a price tag on every Pokémon card listing as you browse, and **Find deals for me** searches Marketplace near you, scrolls through the newest listings and prices everything (titles like "Charizard ex SIR 151" or "Moonbreon PSA 10" work; lots, sealed product and non-English cards are skipped). What it finds is shared on Comps (listing facts only, nothing about you or the seller), so everyone sees the deals; each card page lists its Marketplace copies too. Install: Deals → Marketplace → Get the extension.
- **Raw to Graded** — cards that are cheap raw but sell for a multiple graded (graded prices from PokemonPriceTracker's free plan, learned daily). Expected profit after grading and selling fees, and the **break-even gem rate**: the share of PSA 10s you need to not lose money. Gem rates start from Pokémon-era defaults (WotC, EX–HGSS, BW/XY, Sun & Moon, modern) and you can set your own per card.
- **Sets** — every set by era with its total value, and a binder view of each set.
- **Master Sets** — every card in every printing (normal, reverse holo, Poké Ball, Master Ball, Energy Symbol and more), which ones you have, the value of what you have and the cost to complete. Tap a card to mark the printings you own; switch to "one of each" for a basic set. On the website and in the app.
- **Collection** — scan to add on the phone; see it on the website too. Sign in with the same account on both and they stay in step automatically.

## Unlock more (optional, 2 minutes each)

Add these as repository secrets: **Settings → Secrets and variables → Actions → New repository secret**. The next refresh picks them up.

| Secret | Cost | Unlocks |
|---|---|---|
| `PPT_API_KEY` | free ([pokemonpricetracker.com](https://www.pokemonpricetracker.com/pokemon-card-api), no card) | Graded prices (PSA, CGC, BGS) for **Raw to Graded**. The free plan covers about 50 cards a day; Comps looks up the most valuable cards first, remembers every answer, and re-checks a card only every few weeks — so coverage grows daily without repeat lookups. |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | free ([developer.ebay.com](https://developer.ebay.com/my/keys), production keyset) | Live listing scanner — the strongest "underpriced" signal. |
| `PRICECHARTING_TOKEN` | paid (optional) | Graded prices for every card at once, if you ever want them. Not needed. |

To refresh right away: **Actions → Prices & website → Run workflow**.

## iPhone app

Install `Comps.ipa` with [Sideloadly](https://sideloadly.io) (Windows/Mac) or [AltStore](https://altstore.io) / [SideStore](https://sidestore.io). They sign it with your Apple ID. With a free Apple ID the app must be re-signed every 7 days; AltStore/SideStore do that automatically, and adding the AltStore source above gets you updates.

Every push to `ios/` rebuilds the IPA on a Mac runner (**Actions → iOS app**).

**Scanning.** Point the camera at a card. It finds the card outline, waits until it's steady, flattens it, and reads the name, the collector number and set size (`025/198`, `TG05/TG30`, `SWSH050`) and, on Scarlet & Violet-era and later cards, the printed set code (`PAL EN`). Slab labels are read too (`GEM MT 10` → PSA 10). Then:

- **Matching** scores every plausible card on name, number, set size and set code, and prefers the original printing over reprint products that share its number (Prize Pack, Jumbo, World Championship decks, Trick or Trade, Celebrations Classic Collection…) and over pattern variants (Poké Ball / Master Ball reverse holos), unless the stamp's words are read off the card.
- **Art check:** close calls are settled by comparing the scan with each candidate's official image (Apple's Vision feature prints), so a different artwork with the same name and number loses.
- **Second look:** if a read is unsure and the card is still under the camera, it re-reads a fresh frame with different crops and pools both reads.
- **It learns:** when you pick a different match, the same read resolves to your pick next time. Lock the scanner to a set (top of the screen) when scanning a stack or binder from one set.

Modes:

- **Continuous:** keep feeding cards — each new card lands in the tray with a haptic tick. A fingerprint of the card face stops it re-reading the card that's still there, so you can flip through a stack. Close matches are marked **?** for review, with your scan and the match side by side.
- **Single:** tap the shutter, confirm, add.
- **Binder:** fit a 4-, 9- or 12-pocket page inside the guide and tap the shutter. It takes a full-resolution photo, finds each card (inferring any pocket it can't outline from the page grid), reads and matches every pocket, and shows the page with a ✓ / ? on each card. Add the whole page at once, or fix a pocket first. Tips: lay the page flat, avoid overhead glare on the sleeves, and fill the frame.

## Accounts

Anyone can create an account (email + password) on the website or in the app. Each person's collection, card watchlist and settings are their own and follow them everywhere. Accounts run on a free [Supabase](https://supabase.com) project; set it up once:

1. Create a free project at supabase.com.
2. **Authentication → Sign In / Providers → Email:** turn off **Confirm email** (Supabase's free email sender only reaches project members).
3. **Authentication → URL Configuration:** Site URL = your site (e.g. `https://you.github.io/comps/`).
4. **SQL Editor:** paste [`supabase/schema.sql`](supabase/schema.sql) and run it (safe to run again after updates; run it again to turn on shared Marketplace deals).
5. **Project Settings → API:** add the **Project URL** and **anon public** key to this repository as Actions **variables** `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Both are public by design; row-level security keeps each person's data private. Keep the **service_role** key secret; nothing here needs it.

The next website build turns accounts on, and each price refresh keeps the free project from pausing.

## How the numbers work

**Fair value** anchors on TCGplayer's market price; Cardmarket and PriceCharting only count when they broadly agree (within −35% / +50%), so a mismatched printing can't drag it.

**Deal score (0–100)** — half discount depth, a quarter dollar upside (log scale), a quarter confidence, weighted by signal type. Live listings are filtered hard: proxies, lots, wrong language, wrong printing (1st edition, shadowless, reverse holo), damaged copies and unknown graders are thrown out, and the collector number must match. Cardmarket signals only apply to 2017+ sets, where its printings line up reliably with TCGplayer's.

**Raw to graded** — cost = raw + grading fee + shipping; each outcome (10, 9, 8, ≤7) nets its sale price minus selling fees; expected value = Σ probability × net; break-even = the P(10) at which expected value equals cost. Grading costs are editable on the website (Settings).

## Run it yourself (optional)

The same code runs as a normal server with a live API (collection sync, token auth, image cache):

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:8787. `npm run demo` starts it with labelled sample data instead. Requires Node 22.13+.

## Layout

```
server/            Node, no runtime dependencies (built-in SQLite)
  src/providers/   TCGCSV, TCGdex, PriceCharting, eBay, FX
  src/engine/      valuation, deal signals, grading EV, listing filter, scan matching
  src/export.js    static export for GitHub Pages
  src/cli.js       refresh / export (used by the scheduled workflow)
web/               Preact + Vite website (~31 KB gzipped JS)
ios/               SwiftUI app, iOS 17+, no third-party packages
.github/workflows  data.yml (prices + site), ios.yml (IPA), server.yml (tests)
```

Price data: TCGplayer via TCGCSV, Cardmarket via TCGdex, optional PriceCharting and eBay. Prices are estimates — check sold listings before spending real money. Pokémon and card images are © their respective owners.
