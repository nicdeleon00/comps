// Small shared helpers. No dependencies.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const now = () => Date.now();

/** YYYY-MM-DD in UTC. */
export function day(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function daysAgo(n, from = Date.now()) {
  return day(from - n * 86_400_000);
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Parses "$1,234.56", "1234.56", 123456 (cents when asCents) into dollars. */
export function money(v, { cents = false } = {}) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (cents ? v / 100 : v) : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return cents ? n / 100 : n;
}

const DIACRITICS = /[̀-ͯ]/g;

/** Lowercase, strip accents and punctuation, collapse whitespace. "Pokémon-EX!" -> "pokemon ex" */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(s) {
  return norm(s).split(' ').filter(Boolean);
}

/** Levenshtein distance with early exit. */
function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return rowMin;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 0..1 similarity between two names, tolerant of OCR noise and word order. */
export function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jac = inter / (ta.size + tb.size - inter);
  const prefix = nb.startsWith(na) || na.startsWith(nb) ? 0.9 : 0;
  return Math.max(lev, jac, prefix);
}

/** Minimal RFC 4180 CSV parser that yields row objects keyed by header. */
export function* parseCSV(text) {
  let i = 0;
  const n = text.length;
  const readRow = () => {
    const row = [];
    let field = '';
    let quoted = false;
    while (i < n) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { i++; row.push(field); return row; }
      field += c; i++;
    }
    row.push(field);
    return row;
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const header = readRow().map((h) => h.trim());
  while (i < n) {
    const r = readRow();
    if (r.length === 1 && r[0] === '') continue;
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = r[k] ?? '';
    yield o;
  }
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    let g = m.get(k);
    if (!g) m.set(k, (g = []));
    g.push(x);
  }
  return m;
}

export function safeJSON(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function yearOf(date) {
  const m = /^(\d{4})/.exec(String(date ?? ''));
  return m ? Number(m[1]) : null;
}

export const log = {
  info: (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
  warn: (...a) => console.warn(new Date().toISOString().slice(11, 19), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString().slice(11, 19), 'ERROR', ...a),
};
