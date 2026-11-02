// Scanner matching. The iOS app sends OCR lines from a perspective-corrected
// card image; we pull out the identifiers printed on the card (collector
// number, set code, name) and resolve them against the catalog.

import { similarity, norm, tokens } from '../lib/util.js';

const PKM_NUM = /(?:^|[^\w/])([A-Z]{0,3}\d{1,3}[a-z]?)\s?\/\s?([A-Z]{0,3}\d{2,3})(?![\d])/;
const YGO_CODE = /\b([A-Z0-9]{2,5})-([A-Z]{2})?(\d{3})\b/;
const MTG_SET = /\b([A-Z0-9]{3,5})\s*[•·*.\-]\s*(EN|JA|DE|FR|IT|ES|PT|KO|RU|ZHS|ZHT|PH)\b/;
const MTG_NUM = /(?:^|\s)(?:[CURMSLTP]\s+)?(\d{3,4})(?:\s|$)/;
const HP = /\bHP\s?\d{2,3}\b|\b\d{2,3}\s?HP\b/i;
const NAME_NOISE = /\b(basic|stage\s*[12]|evolves\s+from.*|trainer|item|supporter|stadium|tool|energy\s+card|pok[eé]mon|hp\s?\d+|\d+\s?hp|lv\.?\s?\d+|illus\.?.*|ability|poke-?power|poke-?body|tera)\b/gi;

/** lines: [{ text, x, y, w, h, conf }] with 0..1 coords, origin top-left. */
export function extractFeatures(lines = [], hint = 'auto') {
  const L = lines.filter((l) => l && l.text && String(l.text).trim()).map((l) => ({ ...l, text: String(l.text).trim(), y: l.y ?? 0.5, h: l.h ?? 0.03 }));
  const f = { game: null, name: null, number: null, total: null, setCode: null, lang: null, nameCandidates: [], text: L.map((l) => l.text).join(' ') };

  // Prefer matches near the bottom edge, where collector info is printed.
  const bottomFirst = [...L].sort((a, b) => b.y - a.y);

  for (const l of bottomFirst) {
    const m = YGO_CODE.exec(l.text);
    if (m) { f.setCode = `${m[1]}-${m[2] ?? ''}${m[3]}`; f.game = 'yugioh'; break; }
  }
  if (!f.game) {
    for (const l of bottomFirst) {
      const m = PKM_NUM.exec(l.text);
      if (m) { f.number = m[1]; f.total = m[2]; break; }
    }
    const hasHP = L.some((l) => HP.test(l.text));
    for (const l of bottomFirst) {
      const m = MTG_SET.exec(l.text);
      if (m) { f.setCode = m[1]; f.lang = m[2]; break; }
    }
    if (f.setCode && !hasHP) {
      f.game = 'mtg';
      if (!f.number) {
        for (const l of bottomFirst.filter((x) => x.y > 0.85)) {
          const m = MTG_NUM.exec(l.text);
          if (m) { f.number = m[1]; break; }
        }
      }
    } else if (f.number || hasHP) {
      f.game = 'pokemon';
    }
  }
  if (hint && hint !== 'auto') f.game = hint;

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
const numVariants = (n) => [...new Set([String(n ?? '').toUpperCase(), numKey(n)])];

function rank(rows, f, reason) {
  return rows.map((c) => {
    let s = 0.5;
    if (f.name) s = 0.25 + 0.75 * Math.max(...[f.name, ...f.nameCandidates].map((n) => similarity(n, c.name)));
    if (f.total && c.printed_total && String(c.printed_total) === String(Number(f.total) || f.total)) s += 0.1;
    return { row: c, score: Math.min(1, s), reason };
  }).sort((a, b) => b.score - a.score);
}

/** Resolves features against the local catalog. Returns [{ row, score, reason }]. */
export function matchLocal(db, f) {
  const results = [];
  if (f.game === 'yugioh' && f.setCode) {
    const rows = db.all(`SELECT * FROM cards WHERE game = 'yugioh' AND upper(set_code) = upper(?)`, f.setCode);
    results.push(...rank(rows, f, 'set code'));
  }
  if (f.game === 'mtg' && f.setCode && f.number) {
    const rows = db.all(`SELECT * FROM cards WHERE game = 'mtg' AND lower(set_code) = lower(?) AND ltrim(number, '0') = ltrim(?, '0')`, f.setCode, String(f.number));
    results.push(...rank(rows, f, 'set + number').map((r) => ({ ...r, score: Math.max(r.score, 0.9) })));
  }
  if ((f.game === 'pokemon' || !f.game) && f.number) {
    const nv = numVariants(f.number);
    const rows = db.all(`SELECT * FROM cards WHERE game = 'pokemon' AND upper(number) IN (${nv.map(() => '?').join(',')}) LIMIT 120`, ...nv);
    let ranked = rank(rows, f, 'number');
    if (f.total) {
      const exact = ranked.filter((r) => String(r.row.printed_total) === String(Number(f.total) || f.total));
      if (exact.length) ranked = exact.map((r) => ({ ...r, reason: 'number + set size' }));
    }
    results.push(...ranked);
  }
  if (results.length < 3 && f.name) {
    const q = tokens(f.name).filter((t) => t.length > 1).slice(0, 5).map((t) => `"${t}"*`).join(' ');
    if (q) {
      const gameFilter = f.game ? 'AND c.game = ?' : '';
      const params = f.game ? [q, f.game] : [q];
      const rows = db.all(`SELECT c.* FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ? ${gameFilter} AND c.id NOT IN (SELECT pc_id FROM links) ORDER BY bm25(cards_fts) LIMIT 40`, ...params);
      results.push(...rank(rows, f, 'name').map((r) => ({ ...r, score: r.score * 0.85 })));
    }
  }
  const seen = new Set();
  return results.filter((r) => (seen.has(r.row.id) ? false : seen.add(r.row.id))).sort((a, b) => b.score - a.score).slice(0, 10);
}

/** Free-text search across the catalog (search box, manual add). */
export function searchCatalog(db, q, { game, limit = 30 } = {}) {
  const toks = tokens(q).filter(Boolean).slice(0, 6);
  if (!toks.length) return [];
  const fts = toks.map((t) => `"${t}"*`).join(' ');
  const params = [fts];
  let where = '';
  if (game) { where = 'AND c.game = ?'; params.push(game); }
  const rows = db.all(`SELECT c.*, (SELECT MAX(raw) FROM valuations v WHERE v.card_id = c.id) AS best
    FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
    WHERE cards_fts MATCH ? ${where} AND c.id NOT IN (SELECT pc_id FROM links)
    ORDER BY bm25(cards_fts, 10.0, 2.0, 4.0) LIMIT 200`, ...params);
  const nq = norm(q);
  return rows
    .map((r) => ({ r, s: similarity(nq, r.name) + (r.best ? Math.min(0.3, Math.log10(r.best + 1) / 10) : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
