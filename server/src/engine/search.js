// Catalog search for the search box and "add a card" (self-hosted server).

import { similarity, norm, tokens } from '../lib/util.js';

const numKey = (n) => String(n ?? '').toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
/** "004" -> ["004","4"], "TG05" -> ["TG05","TG5"] (catalogs differ on zero padding). */
const numVariants = (n) => [...new Set([String(n ?? '').toUpperCase().replace(/^0+/, ''), numKey(n)])];

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
  const rows = db.all(`SELECT c.*, (SELECT MAX(raw) FROM valuations v WHERE v.card_id = c.id) AS best
    FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
    WHERE cards_fts MATCH ? AND c.id NOT IN (SELECT pc_id FROM links)
    ORDER BY bm25(cards_fts, 10.0, 2.0, 4.0) LIMIT 200`, fts);
  const nq = norm(q);
  const filtered = numMatch ? rows.filter((r) => numVariants(numMatch[1]).includes(String(r.number ?? '').toUpperCase().replace(/^0+/, ''))) : rows;
  return (filtered.length ? filtered : rows)
    .map((r) => ({ r, s: similarity(nq, r.name) + (r.best ? Math.min(0.3, Math.log10(r.best + 1) / 10) : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
