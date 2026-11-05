// Matches a Marketplace listing title ("Charizard ex SIR 151", "Moonbreon PSA 10",
// "Eevee 074/131 Master Ball") to cards in the Comps price index and values it.
//
// A card number pins the card down. Without one, the card's name is found in the
// title and narrowed by set words ("151", "evolving skies"), rarity words ("SIR",
// "alt art", "gold") and printing words ("reverse", "1st edition"). When a title
// still fits several cards, the answer is a price range and the listing only
// counts as a deal if it's under even the cheapest of them.

const SKIP = new RegExp([
  String.raw`\b(lots?|bundles?|bulk|collections?|binders?|bags?|box(es)?|etb|elite trainer|boosters?|packs?|tins?|sealed|mystery|repacks?|random|blind`,
  String.raw`|proxy|proxies|custom|fake|orica|replica|metal|gold plated|jumbo|oversized|coin|code cards?|online codes?|sleeves?|playmats?|deck boxes|decks?`,
  String.raw`|plush|figures?|toys?|funko|lego|shirt|hoodie|poster|keychain|stickers?|empty|display|case|portfolio|album`,
  String.raw`|japanese|japan|jpn|jp|korean|kor|chinese|chn|french|german|spanish|italian|portuguese|thai|indonesian`,
  String.raw`|wtb|iso|buying|looking for|want to buy|trade only|trades only`,
  String.raw`|\d+\s*x\b|x\s*\d+\b|\d+\s*\+?\s*cards|\d+\s*pcs)\b`,
].join(''), 'i');
const NUMBER = /(?:^|[^\w/])#?([A-Za-z]{0,4}\d{1,3}[a-z]?)\s*\/\s*([A-Za-z]{0,4}\d{1,3})(?![\w/])/;
const PROMO_NUMBER = /\b(SWSH|SVP|SV-P|SM|XY|BW|TG|GG|SV|RC)\s*-?\s*(\d{1,3})\b/i;
const GRADE = /\b(PSA|CGC|BGS|SGC|TAG|ACE|BECKETT)\s*-?\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?![\d.])/i;
const PATTERNS = [
  [/\bmaster\s*ball(\s*(pattern|reverse|holo))?\b/i, 'master ball'],
  [/\bpok[eé]\s*ball(\s*(pattern|reverse|holo))?\b/i, 'poke ball'],
  [/\benergy\s*symbol(\s*(pattern|reverse|holo))?\b/i, 'energy symbol'],
];
// Famous nicknames → what sellers mean.
const NICKNAMES = [
  [/\bmoon\s*breon\b/i, 'Umbreon VMAX 215/203 Evolving Skies'],
  [/\bsun\s*peon\b/i, 'Espeon VMAX 270/264 Fusion Strike'],
  [/\bzard\b/i, 'Charizard'],
];
// Rarity words and what they can mean in the catalog (rarity text or a name tag).
const RARITY_HINTS = [
  [/\b(sir|special illustration( rare)?|special art( rare)?|sar)\b/i, (c) => /special illustration/i.test(c.rarity ?? '')],
  [/\b(alt(ernate)?\.?\s*art|alt)\b/i, (c) => c.tags.some((t) => /alternate/.test(t)) || /special illustration|illustration rare/i.test(c.rarity ?? '')],
  [/\b(ir|illustration rare|art rare|chr|character rare)\b/i, (c) => /^illustration rare|character/i.test(c.rarity ?? '')],
  [/\b(gold|hyper( rare)?|secret( rare)?)\b/i, (c) => /hyper|secret/i.test(c.rarity ?? '') || c.tags.some((t) => /secret/.test(t))],
  [/\brainbow\b/i, (c) => /rainbow|secret/i.test(c.rarity ?? '') || c.tags.some((t) => /secret/.test(t))],
  [/\b(full art|fa)\b/i, (c) => c.tags.some((t) => /full art/.test(t)) || /ultra rare|full art/i.test(c.rarity ?? '')],
  [/\bshiny\b/i, (c) => /shiny/i.test(c.rarity ?? '') || /shiny|shining/i.test(c.setName)],
  [/\b(trainer gallery|tg\d*)\b/i, (c) => /^TG/i.test(c.number) || /trainer gallery/i.test(c.setName)],
  [/\bpromo\b/i, (c) => /promo/i.test(c.setName)],
];
// Words that describe a listing rather than name a card.
const NOISE = new Set(('pokemon pokmon card cards tcg ccg holo holographic reverse rev rare mint nm near lp mp graded psa cgc bgs sgc tag beckett gem ' +
  'sir sar ir alt alternate art full fa secret gold rainbow hyper illustration special promo english eng new obo firm sale cash only price single ' +
  'singles 1st first edition shadowless unlimited vintage wotc pack fresh pulled slab slabbed authentic real nice clean pristine perfect great condition ' +
  'excellent sleeved toploader toploaded for the a of from set').split(' '));
// Set-name words too common to tell sets apart.
const SET_NOISE = new Set('pokemon set the and of scarlet violet sword shield sun moon xy black white promo promos cards card series sv swsh sm bw mega collection'.split(' '));

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/'s\b/g, 's').replace(/\bv[\s-]+(max|star|union)\b/g, 'v$1').replace(/[^a-z0-9]+/g, ' ').trim();
export const numKey = (n) => String(n ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/^([A-Z]*)0+(?=\d)/, '$1');
const TAG = /\s*[([]([^()[\]]*)[)\]]\s*$/;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };

function splitName(name) {
  let base = String(name).trim();
  const tags = [];
  for (let m = TAG.exec(base); m && m.index > 0; m = TAG.exec(base)) {
    tags.unshift(m[1].toLowerCase().replace(/\s+pattern$/, '').trim());
    base = base.slice(0, m.index).trim();
  }
  return { base: base.replace(/\s+-\s+.*$/, ''), tags };
}

/** Builds the lookups once from the published index.json. */
export function buildLookup(index) {
  const byNumber = new Map();
  const byName = new Map(); // first word → [{ words, cards }]
  const names = new Map();
  for (const [pid, name, setId, number, total, rarity, variants] of index.cards) {
    if (!number || !variants?.length) continue;
    const { base, tags } = splitName(name);
    const set = index.sets[setId] ?? [];
    const setName = set[0] ?? '';
    const card = { pid, name, base, tags, setId, setName, setWords: norm(setName).split(' ').filter((w) => w && !SET_NOISE.has(w)), alt: Boolean(set[4]), number, total, rarity, variants };
    const k = numKey(number);
    if (!byNumber.has(k)) byNumber.set(k, []);
    byNumber.get(k).push(card);
    const key = norm(base);
    if (!key) continue;
    if (!names.has(key)) {
      const entry = { words: key.split(' '), cards: [] };
      names.set(key, entry);
      if (!byName.has(entry.words[0])) byName.set(entry.words[0], []);
      byName.get(entry.words[0]).push(entry);
    }
    names.get(key).cards.push(card);
  }
  for (const list of byName.values()) list.sort((a, b) => b.words.length - a.words.length);
  return { byNumber, byName, imageBase: index.imageBase };
}

// Asking prices people use when they don't mean it: "message me", memes, keyboard mashes.
const MEME_PRICES = new Set([69, 420, 666, 6969, 42069, 80085]);

/**
 * True for prices that aren't real offers: free / $0 / $1, 123 / 1234…, 69 / 420,
 * 1111 / 9999 / 999999, and absurd asks for a cheap card. The website uses the same rule.
 */
export function fakePrice(price, worth = null) {
  if (!(price > 1)) return true;
  if (price >= 100000) return true;
  if (Number.isInteger(price)) {
    const s = String(price);
    if (s.length >= 2 && '123456789'.startsWith(s)) return true; // 12, 123, 1234…
    if (MEME_PRICES.has(price)) return true;
    if (/^(\d)\1+$/.test(s) && (s.length >= 4 || (worth && price > worth * 3))) return true;
  }
  return Boolean(worth && price >= 500 && price > worth * 20);
}

/** "$1,250" / "$45.50" / a reduced "$8$10" (reads as $8). Null for free, other currencies or no price. */
export function parsePrice(text) {
  const m = /^\s*\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(String(text ?? ''));
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return v > 0 ? v : null;
}

/** The longest card name in the title (descriptive words ignored). */
function findName(lookup, words) {
  let best = null;
  for (let i = 0; i < words.length; i++) {
    for (const entry of lookup.byName.get(words[i]) ?? []) {
      if (best && entry.words.length <= best.words.length) break;
      if (entry.words.every((w, j) => words[i + j] === w)) { best = entry; break; }
    }
  }
  return best;
}

function setScore(card, words) {
  if (!card.setWords.length) return 0;
  return card.setWords.filter((w) => words.has(w)).length / card.setWords.length;
}

/** Keeps the candidates that best fit what the title says; null when it asks for something none of them are. */
function narrow(cands, t, words, pattern) {
  let xs = cands;
  const keep = (pred) => { const f = xs.filter(pred); if (f.length) xs = f; return f.length > 0; };
  for (const [re, test] of RARITY_HINTS) if (re.test(t)) keep(test);
  // A pattern printing when the title names one; otherwise the plain card over error prints, stamps and patterns.
  if (pattern) keep((c) => c.tags.includes(pattern));
  else if (!keep((c) => !c.tags.length)) keep((c) => !c.tags.some((tag) => /ball|energy symbol/.test(tag)));
  // Set words (the card's own name doesn't count: "Pikachu" isn't a vote for a Pikachu promo set).
  const scores = xs.map((c) => setScore(c, words));
  const top = Math.max(0, ...scores);
  if (top > 0) xs = xs.filter((_, i) => scores[i] === top);
  if (/\b(1st|first)\s*ed(ition)?\b/i.test(t) && !keep((c) => c.variants.some((v) => /^1stEdition/.test(v[0])))) return null;
  if (/\bshadowless\b/i.test(t) && !keep((c) => /shadowless/i.test(c.setName))) return null;
  keep((c) => !c.alt); // originals over reprint products
  return xs;
}

function pickVariant(card, t) {
  const v = card.variants;
  if (/\b(1st|first)\s*ed(ition)?\b/i.test(t)) return v.find((x) => /^1stEdition/.test(x[0])) ?? v[0];
  if (/\breverse\b|\brev\.?\s*holo\b/i.test(t)) return v.find((x) => x[0] === 'reverseHolofoil') ?? v[0];
  return v.find((x) => x[0] !== 'reverseHolofoil' && !/^1stEdition/.test(x[0])) ?? v[0];
}

function valueOf(variant, grade) {
  if (!grade) return { value: variant[1], basis: 'raw' };
  if (grade.n >= 10 && grade.grader === 'PSA') return { value: variant[3], basis: 'psa10' };
  if (grade.n >= 9 && grade.n < 10) return { value: variant[2], basis: 'g9' };
  return { value: null, basis: 'graded' };
}

/**
 * Prices one listing. Null when it isn't a single card that can be priced; otherwise
 * { card, variant, grade, value, low, high, matches, basis, discount, deal, confident }.
 */
export function matchListing(lookup, { title, price }) {
  let t = String(title ?? '').trim();
  if (!t || SKIP.test(t)) return null;
  for (const [re, real] of NICKNAMES) t = t.replace(re, real);
  const pattern = PATTERNS.find(([re]) => re.test(t))?.[1] ?? null;
  const g = GRADE.exec(t);
  const grade = g ? { grader: g[1].toUpperCase() === 'BECKETT' ? 'BGS' : g[1].toUpperCase(), n: Number(g[2]) } : null;
  const allWords = new Set(norm(t).split(' '));

  let cands = [];
  // "199/165", or a promo / gallery number like "SWSH050", "TG05", "SV107".
  const full = NUMBER.exec(t);
  const promo = full ? null : PROMO_NUMBER.exec(t);
  const num = full ? { text: full[0], n: full[1], total: full[2] } : promo ? { text: promo[0], n: `${promo[1]}${promo[2]}`, total: null } : null;
  const plain = norm(PATTERNS.reduce((s, [re]) => s.replace(re, ' '), t).replace(GRADE, ' ').replace(num?.text ?? '\u0000', ' '));
  const nameWords = plain.split(' ').filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w));
  const name = findName(lookup, nameWords);
  if (num) {
    let byNum = lookup.byNumber.get(numKey(num.n)) ?? [];
    const sameTotal = num.total ? byNum.filter((c) => c.total && numKey(c.total) === numKey(num.total)) : [];
    if (sameTotal.length) byNum = sameTotal;
    // The name has to agree with the number.
    cands = name ? byNum.filter((c) => norm(c.base) === name.words.join(' ')) : byNum.filter((c) => norm(c.base).split(' ').some((w) => w.length >= 3 && allWords.has(w)));
  }
  if (!cands.length && name) cands = name.cards;
  if (!cands.length) return null;

  const setWords = new Set([...allWords].filter((w) => !norm(cands[0].base).split(' ').includes(w)));
  cands = narrow(cands, t, setWords, pattern);
  if (!cands) return null;
  const priced = cands.map((c) => {
    const variant = pickVariant(c, t);
    return { c, variant, ...valueOf(variant, grade) };
  });
  const vals = priced.map((p) => p.value).filter((v) => v != null);
  const low = vals.length ? Math.min(...vals) : null;
  const high = vals.length ? Math.max(...vals) : null;
  // Too many possibilities with prices all over the place: not worth a guess.
  if (priced.length > 6 && (priced.length > 40 || (low && high / low > 25))) return null;

  const tight = priced.length === 1 || (low != null && high / low <= 1.35);
  const mid = vals.length ? median(vals) : null;
  const best = priced.reduce((a, b) => (Math.abs((b.value ?? 1e9) - (mid ?? 0)) < Math.abs((a.value ?? 1e9) - (mid ?? 0)) ? b : a));
  const value = tight ? (priced.length === 1 ? best.value : mid) : null;
  // Unsure: judge the price against the cheapest card it could be.
  const against = value ?? low;
  const discount = against && price ? 1 - price / against : null;
  const fake = fakePrice(price, against);
  const deal = Boolean(!fake && discount != null && discount >= 0.15 && against - price >= 3);
  const c = best.c;
  return {
    card: { id: `tcg:${c.pid}`, name: c.name, set: c.setName, number: c.number, total: c.total, image: `${lookup.imageBase}${c.pid}_200w.jpg` },
    variant: best.variant[0], grade: grade ? `${grade.grader} ${grade.n}` : null, basis: best.basis,
    value, low, high, matches: priced.length, discount: fake ? null : discount, deal, fake, confident: tight,
  };
}
