import { sleep, log } from './util.js';

const UA = 'Comps/1.0 (+self-hosted card price tracker)';
const lastHit = new Map();

/**
 * fetch with timeout, retry on 429/5xx (honours Retry-After), and a per-host
 * minimum interval so we stay polite with free APIs.
 */
export async function request(url, { minInterval = 0, retries = 3, timeout = 30_000, headers = {}, ...init } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    if (minInterval) {
      const wait = (lastHit.get(host) ?? 0) + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      lastHit.set(host, Date.now());
    }
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (attempt >= retries) throw new Error(`${host}: ${err.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt;
      log.warn(`${host} ${res.status}, retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      continue;
    }
    const body = await res.text().catch(() => '');
    const err = new Error(`${host} ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

export async function getJSON(url, opts) {
  const res = await request(url, opts);
  return res.json();
}

export async function getText(url, opts) {
  const res = await request(url, { ...opts, headers: { Accept: '*/*', ...(opts?.headers ?? {}) } });
  return res.text();
}
