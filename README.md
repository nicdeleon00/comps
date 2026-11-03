# Comps — Pokémon card prices, deals and a scanner app

**Website:** https://nicdeleon00.github.io/comps/
**iPhone app:** [Comps.ipa](https://github.com/nicdeleon00/comps/releases/download/ios-latest/Comps.ipa) (sideload) · AltStore source: `https://github.com/nicdeleon00/comps/releases/download/ios-latest/altstore-source.json`

Everything runs on GitHub — nothing to host or keep running on your computer:

- Every 6 hours a GitHub Action downloads prices for **every English Pokémon card** (TCGplayer via [TCGCSV](https://tcgcsv.com), Cardmarket via [TCGdex](https://tcgdex.dev)), finds deals and grading spreads, saves price history, and publishes the website to GitHub Pages.
- The iPhone app reads the same published data and keeps a copy of the whole catalog on the phone, so scanning, search and your collection's value work offline.

## What it does

- **Deals** — cards priced under what they're worth: live eBay Buy It Now listings under fair value, price dips against 30-day history, TCGplayer asks 20–40% under market, and modern cards cheaper on Cardmarket than in the US.
- **Raw to Graded** — cards that are cheap raw but sell for a multiple graded. Expected profit after grading and selling fees, and the **break-even gem rate**: the share of PSA 10s you need to not lose money. Gem rates start from Pokémon-era defaults (WotC, EX–HGSS, BW/XY, Sun & Moon, modern) and you can set your own per card.
- **Sets** — every set by era with its total value, and a binder view of each set.
- **Collection** — on the phone (scan to add) and in the browser (CSV import from the app).

## Unlock more (optional, 2 minutes each)

Add these as repository secrets: **Settings → Secrets and variables → Actions → New repository secret**. The next refresh picks them up.

| Secret | Cost | Unlocks |
|---|---|---|
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | free ([developer.ebay.com](https://developer.ebay.com/my/keys), production keyset) | Live listing scanner — the strongest "underpriced" signal. |
| `PRICECHARTING_TOKEN` | paid subscription | Graded prices (PSA 9/10, BGS, CGC, SGC). Powers **Raw to Graded**. |

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
