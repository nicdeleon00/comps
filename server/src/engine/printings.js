// Reprint products: groups whose cards mostly repeat another set's card under the
// same name and collector number (Prize Pack, World Championship decks, Jumbo
// cards, Trick or Trade, trainer kits, Base Set Shadowless…). When a scan can't
// tell the two apart, the phone's scanner prefers the original printing.

const REPRINT_NAMES = /shadowless|jumbo|prize pack|world championship|deck exclusive|blister|battle academy|trick or trade|miscellaneous|league & championship|trainer kit|training kit|classic collection|professor program|countdown calendar|first partner|southeast asia|alternate art promos|trading card game classic|pikachu world|best of promos|player placement|my first battle|deck kit|energies$/i;

const numberKey = (n) => String(n ?? '').toUpperCase().trim().replace(/^([A-Z]*)0+(?=\d)/, '$1');

/** Set ids (TCGplayer group ids, as strings) that are reprint products. */
export function reprintGroups(db, { minShare = 0.5, minCards = 10 } = {}) {
  const sets = db.all('SELECT id, name, released FROM sets');
  const alt = new Set(sets.filter((s) => REPRINT_NAMES.test(s.name)).map((s) => String(s.id)));

  // Share of each group's cards that first appeared in an earlier group.
  const rows = db.all(`SELECT c.group_id g, lower(c.base_name) b, c.number n, coalesce(c.printed_total, '') t, s.released r
                       FROM cards c JOIN sets s ON s.id = c.group_id WHERE c.id LIKE 'tcg:%'`);
  const rank = (r) => `${r.r ?? '9999'}|${String(r.g).padStart(10, '0')}`;
  const key = (r) => `${r.b}|${numberKey(r.n)}|${numberKey(r.t)}`;
  const first = new Map();
  for (const r of rows) {
    const k = key(r);
    const f = first.get(k);
    if (!f || rank(r) < rank(f)) first.set(k, r);
  }
  const stats = new Map();
  for (const r of rows) {
    const s = stats.get(r.g) ?? { total: 0, repeats: 0 };
    s.total++;
    if (String(first.get(key(r)).g) !== String(r.g)) s.repeats++;
    stats.set(r.g, s);
  }
  for (const [g, s] of stats) if (s.total >= minCards && s.repeats / s.total >= minShare) alt.add(String(g));
  return alt;
}
