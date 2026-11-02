// eBay Browse API (free developer keyset). Used to find live Buy It Now
// listings priced under fair value. Docs: developer.ebay.com/api-docs/buy/browse

import { request } from '../lib/http.js';

const API = process.env.EBAY_API_BASE ?? 'https://api.ebay.com';
export const CATEGORY = { tcg: '183454', sports: '261328' };
export const CONDITION = { graded: '2750', ungraded: '4000' };

let token = null;

async function getToken(settings) {
  if (token && token.key === settings.ebayClientId && token.expires > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${settings.ebayClientId}:${settings.ebayClientSecret}`).toString('base64');
  const res = await request(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
    retries: 1,
  });
  const j = await res.json();
  token = { key: settings.ebayClientId, value: j.access_token, expires: Date.now() + (j.expires_in ?? 7200) * 1000 };
  return token.value;
}

export const ebayConfigured = (s) => Boolean(s.ebayClientId && s.ebayClientSecret);

let callsToday = { day: '', n: 0 };
export function ebayBudgetLeft(settings) {
  const d = new Date().toISOString().slice(0, 10);
  if (callsToday.day !== d) callsToday = { day: d, n: 0 };
  return Number(settings.ebayDailyBudget) - callsToday.n;
}

/**
 * Search live listings. Returns normalized items:
 * { itemId, title, price, shipping, currency, url, image, seller, feedback, buying, endsAt, conditionId }
 */
export async function searchListings(settings, { q, category, minPrice, maxPrice, condition, limit = 100 }) {
  const t = await getToken(settings);
  callsToday.n++;
  const filters = ['buyingOptions:{FIXED_PRICE}', 'priceCurrency:USD'];
  if (minPrice != null || maxPrice != null) filters.push(`price:[${minPrice != null ? minPrice.toFixed(2) : ''}..${maxPrice != null ? maxPrice.toFixed(2) : ''}]`);
  if (condition) filters.push(`conditionIds:{${condition}}`);
  const params = new URLSearchParams({ q, limit: String(limit), sort: 'price', filter: filters.join(',') });
  if (category) params.set('category_ids', category);
  const res = await request(`${API}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': settings.ebayMarketplace || 'EBAY_US' },
    minInterval: 250,
    retries: 2,
  });
  const j = await res.json();
  return (j.itemSummaries ?? []).map((it) => {
    const ship = it.shippingOptions?.find((o) => o.shippingCost)?.shippingCost;
    return {
      itemId: it.itemId,
      title: it.title ?? '',
      price: Number(it.price?.value) || null,
      shipping: ship ? Number(ship.value) || 0 : null,
      currency: it.price?.currency ?? 'USD',
      url: it.itemWebUrl,
      image: it.image?.imageUrl ?? it.thumbnailImages?.[0]?.imageUrl ?? null,
      seller: it.seller?.username ?? null,
      feedback: it.seller?.feedbackPercentage != null ? Number(it.seller.feedbackPercentage) : null,
      feedbackScore: it.seller?.feedbackScore ?? null,
      buying: (it.buyingOptions ?? []).join(','),
      endsAt: it.itemEndDate ?? null,
      conditionId: it.conditionId ?? null,
      country: it.itemLocation?.country ?? null,
    };
  });
}

export function ebaySearchUrl(q, graded) {
  const p = new URLSearchParams({ _nkw: q, _sop: '15', LH_BIN: '1' });
  if (graded != null) p.set('Graded', graded ? 'Yes' : 'No');
  return `https://www.ebay.com/sch/i.html?${p}`;
}

export function ebaySoldUrl(q) {
  const p = new URLSearchParams({ _nkw: q, LH_Sold: '1', LH_Complete: '1', _sop: '13' });
  return `https://www.ebay.com/sch/i.html?${p}`;
}
