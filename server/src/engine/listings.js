// Live listing scanner: searches eBay for cards we have a solid fair value on,
// throws out junk (proxies, lots, wrong printing, damaged), and stores clean
// listings so the signal engine can flag the underpriced ones.

import { searchListings, ebayConfigured, ebayBudgetLeft, CATEGORY, CONDITION } from '../providers/ebay.js';
import { norm, tokens, log } from '../lib/util.js';

const GRADE_RE = /\b(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|ARS|HGA)\b\s*[-:#]?\s*(?:GEM\s*(?:MINT|MT)\s*|MINT\s*|PRISTINE\s*|NM-?MT\s*)?(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4|3|2|1\.5|1)(?![\d.])/i;
const JUNK_RE = /\b(proxy|custom|orica|fan\s*art|replica|reprint|fake|digital|code\s*card|online|ptcgo|ptcgl|mtgo|arena\s*code|art\s*card|gold\s*plated|gold\s*metal|jumbo|oversized?|empty|case\s*only|no\s*card|sleeves?|toploaders?|binder|playmat|deck\s*box|lot|bundle|bulk|playset|you\s*pick|pick\s*your|choose|mystery|repack|box\s*break|booster|etb|elite\s*trainer|read\s*description|see\s*description|not\s*real|unofficial|sticker|coin)\b|\b\d+\s?x\b|\bx\s?\d+\b/i;
const LANG_RE = /\b(japanese|japan|jpn|jp|korean|kor|chinese|chn|s-chinese|t-chinese|german|deutsch|french|francais|italian|italiano|spanish|espanol|portuguese|thai|indonesian)\b/i;
const DAMAGE_RE = /\b(damaged|dmg|heavily\s*played|moderately\s*played|creased?|crease|water\s*damage|poor\s*condition|bent|torn|ripped|inked|writing|played)\b|(?<!\d\s?)\bHP\b|\bMP\b/i;

/** Pulls grader/grade out of a listing title. */
export function parseGrade(title) {
  const m = GRADE_RE.exec(title);
  if (!m) return null;
  let grader = m[1].toUpperCase();
  if (grader === 'BECKETT') grader = 'BGS';
  if (/black\s*label/i.test(title)) return { grader, grade: m[2], blackLabel: true };
  return { grader, grade: m[2] };
}

function hasNumber(title, number, total) {
  if (!number) return true;
  const n = String(number).replace(/^0+(?=\d)/, '');
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pads = `0{0,2}${esc}`;
  const patterns = [new RegExp(`(?:^|[^\\w])#?${pads}\\s*/\\s*\\w+`, 'i'), new RegExp(`#\\s*${pads}\\b`, 'i'), new RegExp(`\\b${pads}\\b`, 'i')];
  if (total) return patterns[0].test(title) || patterns[1].test(title);
  return patterns.some((p) => p.test(title));
}

/**
 * Decides whether a listing is a clean copy of this exact card variant.
 * Returns { ok, reason, grader?, grade? }.
 */
export function classifyListing(title, card, variant) {
  const t = String(title);
  const tl = t.toLowerCase();
  const nameTokens = tokens(card.name).filter((w) => w.length > 1 && !['ex', 'gx', 'v', 'the', 'of'].includes(w));
  const tt = new Set(tokens(t));
  const matched = nameTokens.filter((w) => tt.has(w)).length;
  if (nameTokens.length && matched / nameTokens.length < 0.75) return { ok: false, reason: 'name' };

  const junk = JUNK_RE.exec(t);
  if (junk && !norm(card.name).includes(norm(junk[0]))) return { ok: false, reason: `junk:${junk[0]}` };
  if (LANG_RE.test(t) && !LANG_RE.test(card.set_name ?? '')) return { ok: false, reason: 'language' };

  if (card.game === 'pokemon') {
    if (!hasNumber(t, card.number, card.printed_total)) return { ok: false, reason: 'number' };
    const first = /\b1st\s*(ed|edition)?\b|first\s*edition/i.test(t);
    if (variant.startsWith('1stEdition') !== first) return { ok: false, reason: 'edition' };
    const reverse = /\breverse\b|\brev\s*holo\b/i.test(t);
    if ((variant === 'reverseHolofoil') !== reverse) return { ok: false, reason: 'reverse' };
    if (/shadowless/i.test(t) && !/shadowless/i.test(card.name)) return { ok: false, reason: 'shadowless' };
  } else if (card.game === 'mtg') {
    const foil = /\bfoil\b/i.test(t) && !/\bnon[-\s]?foil\b/i.test(t);
    if ((variant === 'foil' || variant === 'etched') !== foil) return { ok: false, reason: 'foil' };
    if (card.set_name && !tl.includes(norm(card.set_name).split(' ')[0]) && !tl.includes(String(card.set_code).toLowerCase())) return { ok: false, reason: 'set' };
  } else if (card.game === 'yugioh') {
    const code = String(card.set_code ?? '').toLowerCase();
    const short = code.replace(/-(en|eu)(\d)/, '-$2');
    if (code && !tl.includes(code) && !tl.includes(short)) return { ok: false, reason: 'setcode' };
  }

  const g = parseGrade(t);
  if (g) {
    if (!['PSA', 'BGS', 'CGC', 'SGC'].includes(g.grader) || g.blackLabel) return { ok: false, reason: 'grader' };
    return { ok: true, ...g };
  }
  if (/\b(graded|slab|slabbed)\b/i.test(t)) return { ok: false, reason: 'graded-unknown' };
  if (DAMAGE_RE.test(t)) return { ok: false, reason: 'condition' };
  return { ok: true };
}

function queryFor(card) {
  const name = card.name.replace(/[()"]/g, ' ');
  const neg = ' -proxy -custom -orica -lot -digital -japanese';
  switch (card.game) {
    case 'pokemon':
      return `${name} ${card.number}${card.printed_total ? '/' + card.printed_total : ''}${neg}`;
    case 'mtg':
      return `${name} ${card.set_name ?? ''}${neg}`;
    case 'yugioh':
      return `${name} ${card.set_code ?? ''}${neg}`;
    default:
      return `${card.set_name ?? ''} ${name} ${card.number ? '#' + card.number : ''}${neg}`.trim();
  }
}

/** Picks which cards to spend eBay calls on this cycle. */
export function pickCandidates(db, limit) {
  const rows = db.all(`
    SELECT * FROM (
      SELECT v.card_id, v.variant, 3 AS pri, v.raw AS sortv FROM watchlist w JOIN valuations v ON v.card_id = w.card_id AND v.variant = w.variant
      UNION ALL
      SELECT s.card_id, s.variant, 2, s.profit FROM spreads s WHERE s.profit > 20 AND COALESCE(s.volume, 10) >= 4
      UNION ALL
      SELECT v.card_id, v.variant, 1, v.raw * v.confidence FROM valuations v
        WHERE v.raw >= 20 AND v.confidence >= 0.6 AND v.card_id NOT IN (SELECT pc_id FROM links)
    ) ORDER BY pri DESC, sortv DESC`);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.card_id}|${r.variant}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  // Rotate: cards scanned least recently first.
  const last = new Map(db.all('SELECT card_id || \'|\' || variant AS k, MAX(fetched_at) t FROM listings GROUP BY k').map((r) => [r.k, r.t]));
  return out.sort((a, b) => (b.pri - a.pri) || ((last.get(`${a.card_id}|${a.variant}`) ?? 0) - (last.get(`${b.card_id}|${b.variant}`) ?? 0)));
}

export async function scanListings(db, settings, { maxCards = 120 } = {}) {
  if (!ebayConfigured(settings)) return { scanned: 0, kept: 0 };
  const candidates = pickCandidates(db, maxCards * 3);
  let scanned = 0;
  let kept = 0;
  for (const cand of candidates) {
    if (scanned >= maxCards || ebayBudgetLeft(settings) < 2) break;
    const card = db.get('SELECT * FROM cards WHERE id = ?', cand.card_id);
    const v = db.get('SELECT * FROM valuations WHERE card_id = ? AND variant = ?', cand.card_id, cand.variant);
    if (!card || !v) continue;
    const category = ['pokemon', 'mtg', 'yugioh'].includes(card.game) ? CATEGORY.tcg : CATEGORY.sports;
    const q = queryFor(card);
    const searches = [];
    if (v.raw >= 5) searches.push({ condition: CONDITION.ungraded, min: v.raw * 0.3, max: v.raw * 1.05 });
    const topGraded = Math.max(v.psa10 ?? 0, v.g9 ?? 0, v.bgs10 ?? 0, v.cgc10 ?? 0);
    if (topGraded >= 20) searches.push({ condition: CONDITION.graded, min: Math.min(v.g8 ?? v.g9 ?? topGraded, topGraded) * 0.3, max: topGraded * 1.05 });
    const items = [];
    for (const s of searches) {
      try {
        items.push(...await searchListings(settings, { q, category, minPrice: s.min, maxPrice: s.max, condition: s.condition }));
      } catch (err) {
        log.warn(`ebay ${card.name}: ${err.message}`);
        if (err.status === 401 || err.status === 403) return { scanned, kept, error: err.message };
      }
    }
    scanned++;
    const t = Date.now();
    db.tx(() => {
      db.run('DELETE FROM listings WHERE card_id = ? AND variant = ?', card.id, cand.variant);
      for (const it of items) {
        if (!it.price || it.currency !== 'USD') continue;
        if (it.feedback != null && it.feedback < 97) continue;
        const c = classifyListing(it.title, card, cand.variant);
        if (!c.ok) continue;
        db.run(`INSERT INTO listings (item_id, card_id, variant, title, price, shipping, currency, buying, grader, grade, url, image, seller, feedback, ends_at, fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET price = excluded.price, shipping = excluded.shipping, fetched_at = excluded.fetched_at`,
          it.itemId, card.id, cand.variant, it.title, it.price, it.shipping, it.currency, it.buying, c.grader ?? null, c.grade ?? null,
          it.url, it.image, it.seller, it.feedback, it.endsAt, t);
        kept++;
      }
    });
  }
  // Listings older than two days are probably sold or stale.
  db.run('DELETE FROM listings WHERE fetched_at < ?', Date.now() - 2 * 86_400_000);
  log.info(`ebay: scanned ${scanned} cards, kept ${kept} clean listings`);
  return { scanned, kept };
}
