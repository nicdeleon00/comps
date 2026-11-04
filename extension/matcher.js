// Matches a Marketplace listing title ("Charizard ex 199/165 SIR 151 PSA 10")
// to a card in the Comps price index, and values it.
//
// Only single cards with a collector number are matched: without a number, a
// title is too vague to price honestly. Lots, sealed product, proxies and
// non-English cards are skipped.

const SKIP = /\b(lots?|bundles?|bulk|collections?|binders?|bags?|box(es)?|etb|elite trainer|booster|packs?|tins?|sealed|mystery|repacks?|random|proxy|proxies|custom|fake|orica|replica|jumbo|oversized|japanese|japan|jpn|korean|chinese|french|german|spanish|italian|portuguese|code cards?|online codes?|sleeves?|playmats?|\d+\s*x\b|x\s*\d+\b|\d+\s+cards)\b/i;
const NUMBER = /(?:^|[^\w])#?([A-Za-z]{0,4}\d{1,3}[a-z]?)\s*\/\s*([A-Za-z]{0,4}\d{1,3})(?![\w])/;
const GRADE = /\b(PSA|CGC|BGS|SGC|TAG|ACE|BECKETT)\s*-?\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)\b/i;
const PATTERNS = [
  [/\bmaster\s*ball\b/i, 'master ball'],
  [/\bpok[eé]\s*ball\b|\bpokeball\b/i, 'poke ball'],
  [/\benergy\s*(symbol)?\s*(pattern|reverse)\b/i, 'energy symbol'],
];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const numKey = (n) => String(n ?? '').toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
const TAG = /\s*[([]([^()[\]]*)[)\]]\s*$/;

function splitName(name) {
  let base = String(name).trim();
  const tags = [];
  for (let m = TAG.exec(base); m && m.index > 0; m = TAG.exec(base)) {
    tags.unshift(m[1].toLowerCase().replace(/\s+pattern$/, '').trim());
    base = base.slice(0, m.index).trim();
  }
  base = base.replace(/\s+-\s+.*$/, '');
  return { base, tags };
}

/** Builds lookups from the published index.json. */
export function buildLookup(index) {
  const byNumber = new Map();
  for (const r of index.cards) {
    const [pid, name, setId, number, total, rarity, variants] = r;
    if (!number || !variants?.length) continue;
    const { base, tags } = splitName(name);
    const set = index.sets[setId] ?? [];
    const entry = { pid, name, base, words: norm(base).split(' ').filter(Boolean), tags, setId, setName: set[0] ?? '', setWords: new Set(norm(`${set[0] ?? ''} ${set[1] ?? ''}`).split(' ')), alt: Boolean(set[4]), number, total, rarity, variants };
    const k = numKey(number);
    if (!byNumber.has(k)) byNumber.set(k, []);
    byNumber.get(k).push(entry);
  }
  return { byNumber, imageBase: index.imageBase };
}

/** Parses "$1,250" / "$45.50" (a reduced "$8$10" reads as $8); null for free, other currencies or no price. */
export function parsePrice(text) {
  const m = /^\s*\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(String(text ?? ''));
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return v > 0 ? v : null;
}

/**
 * Matches one listing. Returns null when it isn't a single card we can price,
 * otherwise { card, variant, grade, value, basis, discount, confident }.
 */
export function matchListing(lookup, { title, price }) {
  const t = String(title ?? '');
  if (!t || SKIP.test(t)) return null;
  const num = NUMBER.exec(t);
  if (!num) return null;
  let cands = lookup.byNumber.get(numKey(num[1])) ?? [];
  if (!cands.length) return null;
  const sameTotal = cands.filter((c) => c.total && numKey(c.total) === numKey(num[2]));
  if (sameTotal.length) cands = sameTotal;

  const words = new Set(norm(t.replace(num[0], ' ')).split(' '));
  const pattern = PATTERNS.find(([re]) => re.test(t))?.[1] ?? null;
  const scored = cands.map((c) => {
    const hit = c.words.filter((w) => words.has(w));
    let s = c.words.length ? hit.length / c.words.length : 0;
    if (!hit.some((w) => w.length >= 3)) s = 0; // the Pokémon's (or trainer's) name has to be there
    const setHits = [...c.setWords].filter((w) => w.length >= 3 && words.has(w)).length;
    s += Math.min(0.3, setHits * 0.1);
    if (pattern ? c.tags.includes(pattern) : !c.tags.length) s += 0.25;
    else if (c.tags.length) s -= 0.15;
    if (c.alt) s -= 0.05; // prefer the original set over reprint products
    return { c, s };
  }).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  const best = scored[0];
  // Two different cards scoring the same means the title doesn't say which one.
  const confident = !(scored[1] && scored[1].s >= best.s - 0.05 && scored[1].c.base !== best.c.base);
  const card = best.c;

  const reverse = /\breverse\b|\brev\s*holo\b|\brh\b/i.test(t);
  const variant = (reverse && card.variants.find((v) => v[0] === 'reverseHolofoil')) || (!reverse && card.variants.find((v) => v[0] !== 'reverseHolofoil')) || card.variants[0];
  const g = GRADE.exec(t);
  const grade = g ? `${g[1].toUpperCase() === 'BECKETT' ? 'BGS' : g[1].toUpperCase()} ${g[2]}` : null;
  let value = null;
  let basis = 'raw';
  if (grade) {
    const n = Number(g[2]);
    if (n >= 10 && g[1].toUpperCase() === 'PSA') { value = variant[3]; basis = 'psa10'; }
    else if (n >= 9 && n < 10) { value = variant[2]; basis = 'g9'; }
    else basis = 'graded';
  } else {
    value = variant[1];
  }
  const discount = value && price ? 1 - price / value : null;
  return {
    card: { id: `tcg:${card.pid}`, name: card.name, set: card.setName, number: card.number, total: card.total, image: `${lookup.imageBase}${card.pid}_200w.jpg` },
    variant: variant[0], grade, value: value ?? null, basis, discount, confident,
  };
}
