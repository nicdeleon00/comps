// Runtime settings. Environment variables win; otherwise values saved from the
// Settings screen (stored in SQLite) are used.

const DEFAULTS = {
  // Graded prices from PokemonPriceTracker's free plan (100 credits/day).
  pptApiKey: '',
  pptDailyCredits: 96,
  pptMinUsd: 2,
  pptMaxUsd: 5000,
  pricechartingToken: '',
  ebayClientId: '',
  ebayClientSecret: '',
  ebayMarketplace: 'EBAY_US',
  ebayDailyBudget: 4000,
  pricechartingCategories: 'pokemon-cards',
  // Cardmarket (EU) prices are fetched for cards worth at least this much.
  euMinUsd: 15,
  euMaxCards: 900,
  // Daily history is kept for card printings worth at least this much.
  historyMinUsd: 1,
  refreshHours: 12,
  listingsHours: 3,
  // Grading economics, editable in Settings.
  gradingFee: 25,
  gradingShipping: 5,
  sellFeePct: 13.25,
  sellFixed: 0.4,
  fxEurUsd: 1.1,
};

const ENV = {
  pptApiKey: 'PPT_API_KEY',
  pptDailyCredits: 'PPT_DAILY_CREDITS',
  pricechartingToken: 'PRICECHARTING_TOKEN',
  ebayClientId: 'EBAY_CLIENT_ID',
  ebayClientSecret: 'EBAY_CLIENT_SECRET',
  ebayMarketplace: 'EBAY_MARKETPLACE',
  pricechartingCategories: 'PRICECHARTING_CATEGORIES',
  refreshHours: 'REFRESH_HOURS',
};

export const SECRET_KEYS = new Set(['pptApiKey', 'pricechartingToken', 'ebayClientId', 'ebayClientSecret']);

export function createSettings(db) {
  const read = () => {
    const stored = Object.fromEntries(db.all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
    const out = {};
    for (const [k, def] of Object.entries(DEFAULTS)) {
      const envVal = ENV[k] ? process.env[ENV[k]] : undefined;
      let v = envVal || stored[k] || def;
      if (typeof def === 'number') v = Number(v);
      out[k] = v;
    }
    out._fromEnv = Object.fromEntries(Object.entries(ENV).map(([k, e]) => [k, Boolean(process.env[e])]));
    out._demo = stored._demo === '1';
    out._fxSource = stored._fxSource ?? 'default';
    return out;
  };

  return {
    get: read,
    set(patch) {
      db.tx(() => {
        for (const [k, v] of Object.entries(patch)) {
          if (!(k in DEFAULTS) && !k.startsWith('_')) continue;
          if (v == null || v === '') db.run('DELETE FROM settings WHERE key = ?', k);
          else db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
        }
      });
      return read();
    },
    /** Safe for the browser: secrets are masked. */
    public() {
      const s = read();
      const out = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (SECRET_KEYS.has(k)) out[k] = s[k] ? `••••${String(s[k]).slice(-4)}` : '';
        else out[k] = s[k];
      }
      out.fromEnv = s._fromEnv;
      out.demo = s._demo;
      out.fxSource = s._fxSource;
      return out;
    },
    grading() {
      const s = read();
      return {
        fee: s.gradingFee,
        shipping: s.gradingShipping,
        sellFeePct: s.sellFeePct / 100,
        sellFixed: s.sellFixed,
      };
    },
  };
}
