// Trading between people: profiles, trade lists, offers and their messages, all in Supabase
// (see the "trading" part of supabase/schema.sql). Collections stay private; a trader can share
// theirs read-only, and offers carry their own copy of each card.

import { rest, rpc, currentUser } from './supabase';
import { post } from './api';

export type Trader = { user_id: string; handle: string; name: string | null; area: string | null; bio: string | null; share_collection: boolean; created_at: number };
/** One card as trading sees it (a trade-list card, a card in an offer, or a card in a shared collection). */
export type TradeCard = {
  id?: string; card_id: string; name: string; set_name?: string | null; number?: string | null; image?: string | null;
  variant?: string | null; grader?: string | null; grade?: string | null; condition?: string | null; language?: string | null;
  quantity: number; value?: number | null; holding_id?: string | null; note?: string | null;
};
export type ListCard = TradeCard & { id: string; user_id: string; kind: 'have' | 'want'; created_at: number };
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'cancelled' | 'countered';
export type Offer = {
  id: string; from_user: string; to_user: string; parent_id: string | null; status: OfferStatus;
  give: TradeCard[]; get: TradeCard[]; cash: number; message: string | null; created_at: number; updated_at: number;
};
export type Message = { id: string; offer_id: string; from_user: string; body: string; created_at: number };
export type Match = { user_id: string; they_have: number; they_want: number };

const enc = encodeURIComponent;
const changed = () => dispatchEvent(new Event('comps:trade'));

// ---------------------------------------------------------------- profiles
export async function myProfile(): Promise<Trader | null> {
  const me = currentUser();
  if (!me) return null;
  const rows = await rest<Trader[]>(`traders?user_id=eq.${me.id}&select=*`);
  return rows[0] ?? null;
}

export async function saveProfile(p: { handle: string; name?: string; area?: string; bio?: string; share_collection?: boolean }, existing: boolean) {
  const body = { handle: p.handle.trim().toLowerCase(), name: p.name?.trim() || null, area: p.area?.trim() || null, bio: p.bio?.trim() || null, share_collection: Boolean(p.share_collection), updated_at: Date.now() };
  const me = currentUser()!;
  try {
    if (existing) await rest(`traders?user_id=eq.${me.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    else await rest('traders', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (/duplicate|unique/i.test((e as Error).message)) throw new Error('That username is taken. Try another.');
    if (/check/i.test((e as Error).message)) throw new Error('Usernames are 3–20 lowercase letters, numbers or _.');
    throw e;
  }
  changed();
}

export const traders = () => rest<Trader[]>('traders?select=*&order=created_at.desc&limit=500');
export const traderByHandle = async (handle: string) => (await rest<Trader[]>(`traders?handle=eq.${enc(handle.toLowerCase())}&select=*`))[0] ?? null;
export const tradersById = async (ids: string[]) => (ids.length ? rest<Trader[]>(`traders?user_id=in.(${ids.join(',')})&select=*`) : Promise.resolve([] as Trader[]));
export const matches = () => rpc<Match[]>('trade_matches', {});

// ---------------------------------------------------------------- trade lists
export const listOf = (userId: string) => rest<ListCard[]>(`trade_cards?user_id=eq.${userId}&select=*&order=created_at.desc&limit=3000`);
/** How many cards each trader has listed, for the trader list. */
export async function listCounts(): Promise<Map<string, { have: number; want: number }>> {
  const rows = await rest<{ user_id: string; kind: 'have' | 'want' }[]>('trade_cards?select=user_id,kind&limit=20000');
  const out = new Map<string, { have: number; want: number }>();
  for (const r of rows) {
    const c = out.get(r.user_id) ?? { have: 0, want: 0 };
    c[r.kind]++;
    out.set(r.user_id, c);
  }
  return out;
}
/** Who has a card for trade (or wants it). */
export const whoHas = (cardId: string, kind: 'have' | 'want' = 'have') => rest<ListCard[]>(`trade_cards?card_id=eq.${enc(cardId)}&kind=eq.${kind}&select=*&limit=200`);

export async function addToList(kind: 'have' | 'want', cards: TradeCard[]) {
  const rows = cards.map((c) => ({
    kind, card_id: c.card_id, name: c.name, set_name: c.set_name ?? null, number: c.number ?? null, image: c.image ?? null,
    variant: c.variant ?? null, grader: c.grader ?? null, grade: c.grade ?? null, condition: c.condition ?? 'NM', language: c.language ?? null,
    quantity: Math.min(999, Math.max(1, c.quantity || 1)), holding_id: c.holding_id ?? null, note: c.note ?? null,
  }));
  // A copy already on the list is skipped (the same card from the collection can't be listed twice):
  // batches of 200, and one at a time only if a batch holds one that's already there.
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    await rest('trade_cards', { method: 'POST', body: JSON.stringify(batch) }).catch(async (e) => {
      if (!/duplicate|unique/i.test((e as Error).message)) throw e;
      for (const r of batch) await rest('trade_cards', { method: 'POST', body: JSON.stringify(r) }).catch((x) => { if (!/duplicate|unique/i.test((x as Error).message)) throw x; });
    });
  }
  changed();
}
export async function updateListCard(id: string, patch: Partial<Pick<ListCard, 'quantity' | 'note' | 'condition'>>) {
  await rest(`trade_cards?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  changed();
}
export async function removeFromList(ids: string[]) {
  if (!ids.length) return;
  await rest(`trade_cards?id=in.(${ids.join(',')})`, { method: 'DELETE' });
  changed();
}

export const sharedCollection = (userId: string) => rpc<TradeCard[]>('trader_collection', { trader: userId });

// ---------------------------------------------------------------- offers
export const offers = () => rest<Offer[]>('trade_offers?select=*&order=updated_at.desc&limit=300');
export const offer = async (id: string) => (await rest<Offer[]>(`trade_offers?id=eq.${id}&select=*`))[0] ?? null;

export async function sendOffer(to: string, give: TradeCard[], get: TradeCard[], cash: number, message: string, counterOf?: string) {
  const strip = (c: TradeCard) => ({ card_id: c.card_id, name: c.name, set_name: c.set_name, number: c.number, image: c.image, variant: c.variant, grader: c.grader, grade: c.grade, condition: c.condition, language: c.language, quantity: c.quantity, value: c.value });
  const id = await rpc<string>('make_offer', { recipient: to, give: give.map(strip), get: get.map(strip), cash, message: message || null, counter_of: counterOf ?? null });
  changed();
  return id;
}
export async function respond(id: string, action: 'accept' | 'decline' | 'cancel') {
  const status = await rpc<OfferStatus>('respond_offer', { offer: id, action });
  changed();
  return status;
}

export const messages = (offerId: string) => rest<Message[]>(`trade_messages?offer_id=eq.${offerId}&select=*&order=created_at.asc&limit=500`);
export async function sendMessage(offerId: string, body: string) {
  await rest('trade_messages', { method: 'POST', body: JSON.stringify({ offer_id: offerId, body: body.trim() }) });
}

/** Offers sent to me that are waiting on an answer. */
export const waitingOn = (list: Offer[], me: string) => list.filter((o) => o.status === 'open' && o.to_user === me);

// ---------------------------------------------------------------- values
/** Today's market value of each card (one copy), from the price data. Null when there's no price. */
export async function values(cards: TradeCard[]): Promise<(number | null)[]> {
  if (!cards.length) return [];
  const res = await post<{ values: (number | null)[] }>('/api/prices', {
    items: cards.map((c) => ({ cardId: c.card_id, variant: c.variant, grader: c.grader, grade: c.grade, condition: c.condition, language: c.language })),
  });
  return res.values;
}

export const sideTotal = (cards: TradeCard[]) => Math.round(cards.reduce((n, c) => n + (c.value ?? 0) * (c.quantity || 1), 0) * 100) / 100;

/** "You give $40 more" / "Even trade" from the sender's side, cash included. */
export function balance(give: TradeCard[], get: TradeCard[], cash: number) {
  const out = sideTotal(give) + Math.max(0, cash);
  const inn = sideTotal(get) + Math.max(0, -cash);
  const diff = Math.round((out - inn) * 100) / 100;
  return { give: out, get: inn, diff };
}

export const STATUS_LABEL: Record<OfferStatus, string> = { open: 'Waiting', accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', countered: 'Countered' };
