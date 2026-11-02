import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  name TEXT NOT NULL,
  set_name TEXT,
  set_code TEXT,
  number TEXT,
  printed_total TEXT,
  rarity TEXT,
  release_date TEXT,
  image TEXT,
  image_large TEXT,
  ext TEXT,
  group_id INTEGER,
  series TEXT,
  base_name TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS cards_game_number ON cards(game, number);
CREATE INDEX IF NOT EXISTS cards_group ON cards(group_id);
CREATE INDEX IF NOT EXISTS cards_series ON cards(series);

CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,
  name TEXT,
  code TEXT,
  series TEXT,
  released TEXT,
  supplemental INTEGER,
  modified TEXT,
  cards INTEGER,
  tcgdex_id TEXT
);

CREATE TABLE IF NOT EXISTS tcgdex_map (
  card_id TEXT PRIMARY KEY,
  tcgdex_id TEXT,
  checked_at INTEGER
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  name, set_name, number,
  content = 'cards', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, name, set_name, number) VALUES (new.rowid, new.name, new.set_name, new.number);
END;
CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name, set_name, number) VALUES ('delete', old.rowid, old.name, old.set_name, old.number);
END;
CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE OF name, set_name, number ON cards
WHEN old.name IS NOT new.name OR old.set_name IS NOT new.set_name OR old.number IS NOT new.number BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name, set_name, number) VALUES ('delete', old.rowid, old.name, old.set_name, old.number);
  INSERT INTO cards_fts(rowid, name, set_name, number) VALUES (new.rowid, new.name, new.set_name, new.number);
END;

-- Latest quote from each source for a card variant. Values in source currency.
CREATE TABLE IF NOT EXISTS quotes (
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  source TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, variant, source)
) WITHOUT ROWID;

-- PriceCharting product <-> catalog card links (graded prices for catalog cards).
CREATE TABLE IF NOT EXISTS links (
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  pc_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (card_id, variant)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_pc ON links(pc_id);

-- Consolidated current valuation (USD) per card variant.
CREATE TABLE IF NOT EXISTS valuations (
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  raw REAL,
  raw_low REAL,
  confidence REAL,
  sources INTEGER,
  g7 REAL, g8 REAL, g9 REAL, g95 REAL, psa10 REAL, bgs10 REAL, cgc10 REAL, sgc10 REAL,
  volume INTEGER,
  change_7d REAL,
  change_30d REAL,
  updated_at INTEGER,
  PRIMARY KEY (card_id, variant)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS valuations_raw ON valuations(raw DESC);

CREATE TABLE IF NOT EXISTS history (
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  day TEXT NOT NULL,
  raw REAL, g9 REAL, psa10 REAL,
  PRIMARY KEY (card_id, variant, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  score REAL NOT NULL,
  price REAL,
  value REAL,
  upside REAL,
  confidence REAL,
  data TEXT,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_kind_score ON signals(kind, score DESC);
CREATE INDEX IF NOT EXISTS signals_card ON signals(card_id);

CREATE TABLE IF NOT EXISTS spreads (
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  raw REAL, g9 REAL, psa10 REAL,
  multiple REAL, cost REAL, ev REAL, profit REAL, roi REAL, break_even REAL,
  volume INTEGER,
  data TEXT,
  computed_at INTEGER,
  PRIMARY KEY (card_id, variant)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS spreads_profit ON spreads(profit DESC);

CREATE TABLE IF NOT EXISTS listings (
  item_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  title TEXT,
  price REAL,
  shipping REAL,
  currency TEXT,
  buying TEXT,
  grader TEXT,
  grade TEXT,
  url TEXT,
  image TEXT,
  seller TEXT,
  feedback REAL,
  ends_at TEXT,
  fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS listings_card ON listings(card_id);

CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  game TEXT,
  name TEXT,
  set_name TEXT,
  number TEXT,
  image TEXT,
  variant TEXT,
  grader TEXT,
  grade TEXT,
  condition TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  cost_basis REAL,
  acquired_at TEXT,
  notes TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS holdings_updated ON holdings(updated_at);

CREATE TABLE IF NOT EXISTS portfolio_history (
  day TEXT PRIMARY KEY,
  value REAL,
  cost REAL,
  count INTEGER
);

CREATE TABLE IF NOT EXISTS watchlist (
  card_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  target REAL,
  created_at INTEGER,
  PRIMARY KEY (card_id, variant)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS gem_rates (
  card_id TEXT PRIMARY KEY,
  p10 REAL, p9 REAL, p8 REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  name TEXT PRIMARY KEY,
  status TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  items INTEGER,
  message TEXT
);
`;

export function openDatabase(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    file = join(dataDir, 'comps.db');
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -64000;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(SCHEMA);
  return wrap(db);
}

/** Adds a statement cache and a transaction helper around DatabaseSync. */
function wrap(db) {
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  let depth = 0;
  return {
    raw: db,
    exec: (sql) => db.exec(sql),
    all: (sql, ...p) => prep(sql).all(...p),
    get: (sql, ...p) => prep(sql).get(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    prepare: prep,
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
