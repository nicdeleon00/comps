// Master sets: every card in a set in every printing it comes in (normal,
// reverse holo, Poké Ball / Master Ball / Energy Symbol patterns, …), what you
// have, and what's left. Built from the published card index, so it works the
// same on the hosted site and a self-hosted server.
//
// TCGplayer lists the pattern printings as their own products, named with a tag:
// "Eevee (Poke Ball Pattern)" #074 sits next to "Eevee" #074. Products with the
// same number and the same name (tags removed) are one card slot.

type IndexVariant = [string, number | null, number | null, number | null, number | null];
export type IndexRow = [number, string, string, string | null, string | null, string | null, IndexVariant[]];
export interface CatalogIndex {
  imageBase: string;
  sets: Record<string, [string, string | null, string, string | null, number?]>;
  cards: IndexRow[];
}
/** A card you have, with its printing already resolved (an unset printing means the regular one). */
interface Owned { cardId: string; variantResolved: string | null; quantity: number }

export interface Printing {
  cardId: string;
  variant: string;
  label: string;
  short: string;
  price: number | null;
  have: number;
}
export interface Slot {
  key: string;
  number: string;
  name: string;
  rarity: string | null;
  cardId: string;
  image: string;
  imageLarge: string;
  printings: Printing[];
}
export type Mode = 'master' | 'base';
export interface Progress {
  total: number;
  owned: number;
  /** What you have, at raw market prices (one of each). */
  value: number;
  /** Buying everything still missing, at raw market prices. */
  toComplete: number;
  /** The whole set at raw market prices. */
  full: number;
  /** Missing printings with no price yet (left out of the cost). */
  unpriced: number;
}

const VARIANT_LABEL: Record<string, [string, string]> = {
  normal: ['Normal', 'N'],
  holofoil: ['Holo', 'H'],
  reverseHolofoil: ['Reverse Holo', 'RH'],
  unlimitedHolofoil: ['Unlimited Holo', 'UH'],
  unlimited: ['Unlimited', 'U'],
  '1stEditionNormal': ['1st Edition', '1st'],
  '1stEditionHolofoil': ['1st Edition Holo', '1st H'],
};
const VARIANT_RANK: Record<string, number> = { normal: 0, holofoil: 1, unlimitedHolofoil: 2, unlimited: 3, reverseHolofoil: 4, '1stEditionNormal': 5, '1stEditionHolofoil': 6 };
// Pattern printings in the order collectors list them.
const PATTERN_RANK = ['poké ball', 'master ball', 'energy symbol', 'friend ball', 'love ball', 'quick ball', 'dusk ball'];

const TAG = /\s*[([]([^()[\]]*)[)\]]\s*$/;

/** "Eevee (Poke Ball Pattern)" → { base: "Eevee", tags: ["Poké Ball"] } */
export function splitName(name: string): { base: string; tags: string[] } {
  let base = name.trim();
  const tags: string[] = [];
  for (let m = TAG.exec(base); m && m.index > 0; m = TAG.exec(base)) {
    tags.unshift(m[1].replace(/\s+Pattern$/i, '').replace(/\bPoke\b/g, 'Poké').trim());
    base = base.slice(0, m.index).trim();
  }
  return { base, tags: tags.filter(Boolean) };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const numKey = (n: string) => n.toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
const initials = (s: string) => s.split(/\s+/).map((w) => w[0]).join('').toUpperCase();

function printingLabel(tags: string[], variant: string, single: boolean): { label: string; short: string } {
  const [vl, vs] = VARIANT_LABEL[variant] ?? [variant, variant.slice(0, 2).toUpperCase()];
  if (!tags.length) return { label: vl, short: vs };
  const tag = tags.join(' · ');
  return single ? { label: tag, short: initials(tags[0]) } : { label: `${tag} ${vl}`, short: `${initials(tags[0])} ${vs}` };
}

const rankOf = (p: { tags: string[]; variant: string }) => {
  if (!p.tags.length) return VARIANT_RANK[p.variant] ?? 9;
  const i = PATTERN_RANK.indexOf(p.tags[0].toLowerCase());
  return 10 + (i < 0 ? PATTERN_RANK.length : i);
};

/** Card number order: 1, 2, … 10, then lettered runs like TG01 or GG01. */
export function compareNumbers(a: string, b: string) {
  const pa = /^([A-Za-z]*)(\d*)(.*)$/.exec(a)!;
  const pb = /^([A-Za-z]*)(\d*)(.*)$/.exec(b)!;
  return pa[1].localeCompare(pb[1]) || (Number(pa[2]) || 0) - (Number(pb[2]) || 0) || pa[3].localeCompare(pb[3]) || a.localeCompare(b);
}

/** Groups the index into sets of card slots (no ownership yet). */
export function slotsBySet(idx: CatalogIndex): Map<string, Slot[]> {
  const bySet = new Map<string, Map<string, { slot: Slot; parts: { tags: string[]; variant: string; p: Printing }[] }>>();
  for (const r of idx.cards) {
    const [pid, name, setId, number, , rarity, variants] = r;
    if (!number || !variants.length) continue;
    const { base, tags } = splitName(name);
    const key = `${numKey(number)}|${norm(base)}`;
    let slots = bySet.get(setId);
    if (!slots) bySet.set(setId, (slots = new Map()));
    let s = slots.get(key);
    const cardId = `tcg:${pid}`;
    if (!s) {
      s = {
        slot: { key, number, name: base, rarity, cardId, image: `${idx.imageBase}${pid}_200w.jpg`, imageLarge: `${idx.imageBase}${pid}_400w.jpg`, printings: [] },
        parts: [],
      };
      slots.set(key, s);
    }
    // The untagged product is the face of the slot.
    if (!tags.length && s.slot.cardId !== cardId && s.parts.every((x) => x.tags.length)) {
      Object.assign(s.slot, { cardId, rarity, image: `${idx.imageBase}${pid}_200w.jpg`, imageLarge: `${idx.imageBase}${pid}_400w.jpg` });
    }
    for (const v of variants) {
      const { label, short } = printingLabel(tags, v[0], variants.length === 1);
      s.parts.push({ tags, variant: v[0], p: { cardId, variant: v[0], label, short, price: v[1], have: 0 } });
    }
  }
  const out = new Map<string, Slot[]>();
  for (const [setId, slots] of bySet) {
    const list = [...slots.values()].map(({ slot, parts }) => {
      parts.sort((a, b) => rankOf(a) - rankOf(b) || a.p.label.localeCompare(b.p.label));
      slot.printings = parts.map((x) => x.p);
      return slot;
    });
    list.sort((a, b) => compareNumbers(a.number, b.number) || a.name.localeCompare(b.name));
    out.set(setId, list);
  }
  return out;
}

/** Copies of each printing you have, keyed "cardId|variant". */
export function ownedMap(items: Owned[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of items) {
    if (!h.variantResolved) continue;
    const k = `${h.cardId}|${h.variantResolved}`;
    m.set(k, (m.get(k) ?? 0) + (h.quantity || 1));
  }
  return m;
}

/** Slots with your copies filled in. */
export function withOwned(slots: Slot[], owned: Map<string, number>): Slot[] {
  return slots.map((s) => ({ ...s, printings: s.printings.map((p) => ({ ...p, have: owned.get(`${p.cardId}|${p.variant}`) ?? 0 })) }));
}

const cents = (x: number) => Math.round(x * 100) / 100;

/** How far along a set is. "master" counts every printing; "base" needs one of each card. */
export function progress(slots: Slot[], mode: Mode): Progress {
  const p: Progress = { total: 0, owned: 0, value: 0, toComplete: 0, full: 0, unpriced: 0 };
  for (const s of slots) {
    if (mode === 'master') {
      for (const x of s.printings) {
        p.total++;
        p.full += x.price ?? 0;
        if (x.have > 0) { p.owned++; p.value += x.price ?? 0; }
        else if (x.price == null) p.unpriced++;
        else p.toComplete += x.price;
      }
    } else {
      p.total++;
      const priced = s.printings.filter((x) => x.price != null).map((x) => x.price!);
      const cheapest = priced.length ? Math.min(...priced) : null;
      p.full += cheapest ?? 0;
      const mine = s.printings.filter((x) => x.have > 0);
      if (mine.length) { p.owned++; p.value += Math.max(0, ...mine.map((x) => x.price ?? 0)); }
      else if (cheapest == null) p.unpriced++;
      else p.toComplete += cheapest;
    }
  }
  p.value = cents(p.value);
  p.toComplete = cents(p.toComplete);
  p.full = cents(p.full);
  return p;
}

/** A slot is done when you have every printing (master) or any printing (base). */
export const slotDone = (s: Slot, mode: Mode) => (mode === 'master' ? s.printings.every((p) => p.have > 0) : s.printings.some((p) => p.have > 0));
