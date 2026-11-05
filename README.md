# Comps

Pokémon card prices, deals and collection tracking, in three parts that share one account:

| | What it is | Get it |
|---|---|---|
| **Website** | Prices and price history for every English Pokémon card, deals, raw-to-graded, sets, master sets, your collection, and Facebook Marketplace deals | https://nicdeleon00.github.io/comps/ |
| **iPhone app** | Card and binder scanner, collection, deals, master sets and search, with every price on the phone so it works offline | [Comps.ipa](https://github.com/nicdeleon00/comps/releases/download/ios-latest/Comps.ipa) (sideload) |
| **Chrome / Edge extension** | Prices every Pokémon card listing on Facebook Marketplace, finds the deals for you, and shares them on the site | Website → Deals → Marketplace → Get the extension |

Everything runs on GitHub. There's no server to host and nothing to keep running on your computer.

---

## Website

- **Market** — the best deals right now, chase cards from the newest set, the biggest raw-to-graded spreads, and this week's movers.
- **Deals** — cards priced under what they're worth, ranked by discount, dollar upside and confidence:
  - **Dips:** down against their 30-day median.
  - **Low asks:** TCGplayer listings 20–40% under market.
  - **Cross-market:** modern cards cheaper on Cardmarket than in the US.
  - **Momentum:** rising in Europe before the US price follows.
  - **Live listings:** eBay Buy It Now under fair value (optional key, below).
  - **Marketplace:** Facebook Marketplace listings found by the extension (yours and everyone else's), each with what it's worth and a **Buy** link.
- **Raw to Graded** — cards that are cheap raw but sell for a multiple graded. Shows the expected profit after grading and selling fees, and the **break-even gem rate**: the share of PSA 10s you need to not lose money. Gem rates start from era defaults (WotC, EX–HGSS, BW/XY, Sun & Moon, modern) and you can set your own per card.
- **Sets** — every set by era with its total value, and a binder view of each one.
- **Master Sets** — every card in every printing: normal, reverse holo, Poké Ball, Master Ball, Energy Symbol and more.
  - For each set it shows what you have, what it's worth, and what it costs to complete.
  - Tap a card to mark the printings you own.
  - "One of each" counts a basic set instead.
- **Collection** — what you own, its value over time, gains against what you paid, and raw and graded copies.
- **Card pages** — price history (daily for 90 days, weekly for a year, monthly back to early 2024) for raw, PSA 9 and PSA 10. Also: prices by grade, "should you grade it?", live eBay listings, copies for sale on Facebook Marketplace, and every source used.
- **Watchlist** — cards you're watching, with a target price.
- **Accounts** — sign in with email and password. Your collection syncs with the iPhone app automatically, and your watchlist and settings follow you to any browser.

## iPhone app

Install `Comps.ipa` with [Sideloadly](https://sideloadly.io) (Windows/Mac), [AltStore](https://altstore.io) or [SideStore](https://sidestore.io); they sign it with your Apple ID.
- With a free Apple ID the app has to be re-signed every 7 days; AltStore and SideStore do that automatically.
- For updates, add this AltStore source: `https://github.com/nicdeleon00/comps/releases/download/ios-latest/altstore-source.json`.
- Requires iOS 17.

Tabs: **Collection**, **Scan**, **Deals** (undervalued and raw-to-graded), **Master Sets** and **Search**. Sign in under Settings with the same account as the website.

**Scanning.** Point the camera at a card. The app finds its outline, waits until it's steady, flattens it, and reads:
- the name, the collector number and set size (`025/198`, `TG05/TG30`, `SWSH050`);
- on Scarlet & Violet-era and later cards, the printed set code (`PAL EN`);
- slab labels (`GEM MT 10` → PSA 10).

It then:

- **Matches** every plausible card on name, number, set size and set code. It prefers the original printing over reprint products that share its number (Prize Pack, Jumbo, World Championship decks, Celebrations…) and over pattern variants, unless the card says otherwise.
- **Checks the art.** Close calls are settled by comparing your scan with each candidate's official image, so a different artwork with the same name and number loses.
- **Takes a second look.** If a read is unsure and the card is still in view, it re-reads a fresh frame and pools both reads.
- **Learns.** When you pick a different match, the same read resolves to your pick next time. Lock the scanner to one set when you're scanning a stack or binder from that set.

Modes:

- **Continuous:** keep feeding cards. Each one lands in the tray with a haptic tick, and you can flip through a stack without it re-reading the card still in view. Unsure matches are marked **?** for review, with your scan and the match side by side.
- **Single:** tap the shutter, confirm, add.
- **Binder:** fit a 4-, 9- or 12-pocket page in the guide and tap the shutter. Every pocket is found, read and matched, and you add the whole page at once or fix a pocket first. Lay the page flat and avoid glare on the sleeves.

## Comps for Marketplace (Chrome / Edge extension)

- **Price tags on every card listing** on Facebook Marketplace: green "▼ 43% under · worth $317" for deals.
  - It reads the listing data Facebook sends the page (title, price, place, photo, sold or pending), and reads the screen as a fallback.
  - Titles like "Charizard ex SIR 151", "Moonbreon PSA 10" or "Eevee master ball prismatic" work. When a title could be several cards, the tag shows a price range.
  - Lots, sealed product, non-English cards and fake prices ($0, free, $1, 123, 1234, 9999…) are ignored.
- **A panel on Marketplace** (bottom right):
  - Pick presets (Pokémon cards, graded slabs, alt arts & SIRs, Charizard, Eeveelutions, Pikachu, vintage) or your own words, a price range and how recent.
  - **Search now** runs each search, newest first, and scrolls through it.
  - **Check by itself** every 15 min to 3 h in a background tab while Chrome is open, with a desktop alert for new deals. It's off until you switch it on.
- **Shared on the site:** what it finds appears on Deals → Marketplace and on each card's page, for everyone. Only listing facts are shared, never anything about you or the seller. You can switch sharing off.
- **Updates itself** from the website after a one-time OK on its welcome page.

Install: download it from Deals → Marketplace and unzip it somewhere permanent. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick the folder. On the welcome page, press **Turn on automatic updates** and pick the same folder.

> Facebook's terms don't allow automated browsing. Price tags and **Search now** only read pages you open; the background check is automated, so it's off unless you turn it on, and you use it at your own risk.

## How it works

Every 6 hours a GitHub Action ([`data.yml`](.github/workflows/data.yml)) does the following:

1. Downloads prices for every English Pokémon card and printing: TCGplayer via [TCGCSV](https://tcgcsv.com), and Cardmarket via [TCGdex](https://tcgdex.dev) for cards worth $15+.
2. Fills in price history from TCGCSV's daily archives.
3. Looks up graded prices.
4. Finds deals and grading spreads.
5. Publishes the website to GitHub Pages, along with the data files the app and the extension read.

Other workflows rebuild the iPhone app ([`ios.yml`](.github/workflows/ios.yml)) and run the tests ([`server.yml`](.github/workflows/server.yml)).

**Fair value** starts from TCGplayer's market price. Cardmarket and PriceCharting only count when they broadly agree (within −35% / +50%), so a mismatched printing can't drag it.

**Deal score (0–100)** is half discount depth, a quarter dollar upside (log scale) and a quarter confidence, weighted by signal type. Live listings are filtered hard: proxies, lots, wrong language, wrong printing, damaged copies and unknown graders are thrown out, and the collector number must match. Cardmarket signals only apply to 2017+ sets, where its printings line up reliably with TCGplayer's.

**Raw to graded:**
- **Cost** = raw price + grading fee + shipping.
- Each outcome (PSA 10, 9, 8, 7 or lower) nets its sale price minus selling fees.
- **Expected value** = Σ probability × net.
- **Break-even** is the PSA 10 rate at which expected value equals cost.

You can change grading and selling costs in Settings.

## Setting up your own copy

Fork the repository, enable GitHub Pages (Settings → Pages → branch `gh-pages`) and run **Actions → Prices & website → Run workflow**. Everything below is optional.

The app and the extension point at this site by default. In the app, scan the code on your site's Settings page (or type its address under Settings → Price site). For the extension, change `SITE` in `extension/background.js`, `marketplace.js` and `update.js`, and the site address in `manifest.json`.

**Price sources.** Add any of these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Cost | Adds |
|---|---|---|
| `PPT_API_KEY` | free ([PokemonPriceTracker](https://www.pokemonpricetracker.com/pokemon-card-api)) | Graded prices (PSA, CGC, BGS). The free plan covers about 50 cards a day. Comps looks up the most valuable cards first, remembers every answer and re-checks a card only every few weeks, so coverage grows daily. |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | free ([eBay developers](https://developer.ebay.com/my/keys), production keyset) | Live eBay listings, the strongest "underpriced" signal. |
| `PRICECHARTING_TOKEN` | paid | Graded prices for every card at once. Not needed. |

**Accounts and shared Marketplace deals** run on a free [Supabase](https://supabase.com) project:

1. Create a project.
2. **Authentication → Sign In / Providers → Email:** turn off **Confirm email**. Supabase's free email sender only reaches project members.
3. **Authentication → URL Configuration:** set Site URL to your site.
4. **SQL Editor:** paste [`supabase/schema.sql`](supabase/schema.sql) and run it. It's safe to run again after updates.
5. **Project Settings → API:** add the Project URL and the **anon public** key as Actions **variables** `SUPABASE_URL` and `SUPABASE_ANON_KEY`, or put them in [`supabase/public.json`](supabase/public.json). Both are public by design, and row-level security keeps each person's data private. Keep the service_role key secret; nothing here needs it.

Each price refresh also keeps the free Supabase project from pausing.

**Run it as a server** instead (a live API with your collection on the server, token sign-in and an image cache). It needs Node 22.13+:

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:8787. `npm run demo` starts it with sample data. Run the tests with `npm test`.

## Code

```
server/      Node, no runtime dependencies (built-in SQLite): price providers, valuation,
             deal signals, grading math, catalog search, the static export
web/         Preact + Vite website
ios/         SwiftUI app, iOS 17+, no third-party packages
extension/   Comps for Marketplace (Chrome / Edge, Manifest V3)
supabase/    accounts and shared Marketplace listings: schema and its tests
```

Prices are estimates, so check sold listings before spending real money. Pokémon and card images are © their respective owners.
