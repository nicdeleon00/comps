// Scanner matching. The iOS app sends OCR lines from a perspective-corrected
// card image; we pull out the identifiers printed on the card (collector
// number, set code, name) and resolve them against the catalog.

import { similarity, norm, tokens } from '../lib/util.js';

const PKM_NUM = /(?:^|[^\w/])([A-Z]{0,3}\d{1,3}[a-z]?)\s?\/\s?([A-Z]{0,3}\d{2,3})(?![\d])/;
const PROMO = /\b(SWSH|SVP|SV|SM|XY|BW|HGSS|DP|MEP)\s?(\d{2,3})\b/i;
const NAME_NOISE = /\b(basic|stage\s*[12]|evolves\s+from.*|trainer|item|supporter|stadium|tool|energy\s+card|pok[eé]mon|hp\s?\d+|\d+\s?hp|lv\.?\s?\d+|illus\.?.*|ability|poke-?power|poke-?body|tera)\b/gi;

/** lines: [{ text, x, y, w, h, conf }] with 0..1 coords, origin top-left. Pokémon cards only. */
export function extractFeatures(lines = []) {
  const L = lines.filter((l) => l && l.text && String(l.text).trim()).map((l) => ({ ...l, text: String(l.text).trim(), y: l.y ?? 0.5, h: l.h ?? 0.03 }));
  const f = { game: 'pokemon', name: null, number: null, total: null, setCode: null, nameCandidates: [], text: L.map((l) => l.text).join(' ') };

  // Collector info is printed along the bottom edge; prefer matches there.
  const bottomFirst = [...L].sort((a, b) => b.y - a.y);
  for (const l of bottomFirst) {
    const m = PKM_NUM.exec(l.text);
    if (m) { f.number = m[1]; f.total = m[2]; break; }
  }
  if (!f.number) {
    for (const l of bottomFirst) {
      const m = PROMO.exec(l.text);
      if (m) { f.number = `${m[1].toUpperCase()}${m[2]}`; break; }
    }
  }

  // Name: biggest text in the top band of the card.
  const top = L.filter((l) => l.y < 0.22).sort((a, b) => b.h - a.h);
  for (const l of top) {
    const cleaned = l.text.replace(NAME_NOISE, ' ').replace(/[^\p{L}\p{N}'’&.:,\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 3 && /\p{L}{2,}/u.test(cleaned)) f.nameCandidates.push(cleaned);
  }
  f.name = f.nameCandidates[0] ?? null;
  return f;
}

const numKey = (n) => String(n ?? '').toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
/** "004" -> ["004","4"], "TG05" -> ["TG05","TG5"] (catalogs differ on zero padding). */
const numVariants = (n) => [...new Set([String(n ?? '').toUpperCase().replace(/^0+/, ''), numKey(n)])];

function rank(rows, f, reason) {
  const names = [f.name, ...f.nameCandidates].filter(Boolean);
  const totalKey = (t) => String(t ?? '').toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
  return rows.map((c) => {
    let s = 0.5;
    if (names.length) s = 0.25 + 0.75 * Math.max(...names.map((n) => Math.max(similarity(n, c.base_name || c.name), similarity(n, c.name))));
    if (f.total && c.printed_total && totalKey(c.printed_total) === totalKey(f.total)) s += 0.1;
    return { row: c, score: Math.min(1, s), reason };
  }).sort((a, b) => b.score - a.score);
}

/** Resolves features against the local catalog. Returns [{ row, score, reason }]. */
export function matchLocal(db, f) {
  const results = [];
  if (f.number) {
    const nv = numVariants(f.number);
    const rows = db.all(`SELECT * FROM cards WHERE game = 'pokemon' AND upper(ltrim(number, '0')) IN (${nv.map(() => '?').join(',')}) LIMIT 400`, ...nv);
    let ranked = rank(rows, f, 'number');
    if (f.total) {
      const tk = (t) => String(t ?? '').toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
      const exact = ranked.filter((r) => tk(r.row.printed_total) === tk(f.total));
      if (exact.length) ranked = exact.map((r) => ({ ...r, reason: 'number + set size' }));
    }
    results.push(...ranked);
  }
  if (results.length < 3 && f.name) {
    const q = tokens(f.name).filter((t) => t.length > 1).slice(0, 5).map((t) => `"${t}"*`).join(' ');
    if (q) {
      const rows = db.all(`SELECT c.* FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ? AND c.id NOT IN (SELECT pc_id FROM links) ORDER BY bm25(cards_fts) LIMIT 60`, q);
      results.push(...rank(rows, f, 'name').map((r) => ({ ...r, score: r.score * 0.85 })));
    }
  }
  const seen = new Set();
  return results.filter((r) => (seen.has(r.row.id) ? false : seen.add(r.row.id))).sort((a, b) => b.score - a.score).slice(0, 10);
}

/** Free-text search across the catalog (search box, manual add). */
export function searchCatalog(db, q, { limit = 30 } = {}) {
  const numMatch = /([A-Za-z]*\d+[a-z]?)\s*\/\s*([A-Za-z]*\d+)/.exec(q);
  const toks = tokens(q.replace(/[A-Za-z]*\d+[a-z]?\s*\/\s*[A-Za-z]*\d+/, ' ')).filter(Boolean).slice(0, 6);
  if (numMatch && !toks.length) {
    const nv = numVariants(numMatch[1]);
    return db.all(`SELECT c.*, (SELECT MAX(raw) FROM valuations v WHERE v.card_id = c.id) AS best FROM cards c
      WHERE upper(ltrim(number, '0')) IN (${nv.map(() => '?').join(',')}) AND c.id NOT IN (SELECT pc_id FROM links) LIMIT ?`, ...nv, limit);
  }
  if (!toks.length) return [];
  const fts = toks.map((t) => `"${t}"*`).join(' ');
  const params = [fts];
  const where = '';
  const rows = db.all(`SELECT c.*, (SELECT MAX(raw) FROM valuations v WHERE v.card_id = c.id) AS best
    FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
    WHERE cards_fts MATCH ? ${where} AND c.id NOT IN (SELECT pc_id FROM links)
    ORDER BY bm25(cards_fts, 10.0, 2.0, 4.0) LIMIT 200`, ...params);
  const nq = norm(q);
  const filtered = numMatch ? rows.filter((r) => numVariants(numMatch[1]).includes(String(r.number ?? '').toUpperCase().replace(/^0+/, ''))) : rows;
  return (filtered.length ? filtered : rows)
    .map((r) => ({ r, s: similarity(nq, r.name) + (r.best ? Math.min(0.3, Math.log10(r.best + 1) / 10) : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
