// EUR→USD from the ECB via Frankfurter (free, no key). Used to compare
// Cardmarket (EU) prices with US prices.

import { getJSON } from '../lib/http.js';
import { log } from '../lib/util.js';

const URLS = ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', 'https://api.frankfurter.app/latest?from=EUR&to=USD'];

export async function refreshFx(settings, store) {
  for (const url of URLS) {
    try {
      const j = await getJSON(url, { retries: 1, timeout: 10_000 });
      const rate = Number(j?.rates?.USD);
      if (rate > 0.5 && rate < 2) {
        store.set({ fxEurUsd: rate, _fxSource: `ECB ${j.date ?? ''}`.trim() });
        return rate;
      }
    } catch (err) {
      log.warn(`fx: ${err.message}`);
    }
  }
  return settings.fxEurUsd;
}
