// Asking prices people use when they don't mean it. Same rule as the extension's
// matcher (extension/matcher.js); a test checks the two agree.

const MEME_PRICES = new Set([69, 420, 666, 6969, 42069, 80085]);

/** Free / $0 / $1, 12 / 123 / 1234…, 69 / 420, 1111 / 9999 / 999999, and absurd asks for a cheap card. */
export function fakePrice(price: number | null, worth: number | null = null) {
  if (price == null || !(price > 1)) return true;
  if (price >= 100000) return true;
  if (Number.isInteger(price)) {
    const s = String(price);
    if (s.length >= 2 && '123456789'.startsWith(s)) return true;
    if (MEME_PRICES.has(price)) return true;
    if (/^(\d)\1+$/.test(s) && (s.length >= 4 || (worth != null && price > worth * 3))) return true;
  }
  return Boolean(worth && price >= 500 && price > worth * 20);
}
