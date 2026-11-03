// The secret gist that the website, the iPhone app and this monitor share.
//   comps-collection.json  your collection (website + app)
//   comps-drops.json       what to watch, and which phones get alerts (website + app)
//   comps-monitor.json     what the monitor sees: stock status, drops, heartbeat (monitor only)

export const COLLECTION_FILE = 'comps-collection.json';
export const DROPS_FILE = 'comps-drops.json';
export const MONITOR_FILE = 'comps-monitor.json';
export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Comps%20collection%20sync';

export class GistError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Gist {
  constructor(token, id = null) {
    this.token = token.trim();
    this.id = id;
  }

  async req(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'comps-drop-monitor',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401) throw new GistError(401, 'The GitHub key was revoked or expired. Run with --setup and paste a new one.');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new GistError(429, 'GitHub rate limit reached; waiting.');
    if (res.status === 403) throw new GistError(403, 'The GitHub key needs the "gist" permission.');
    if (!res.ok) throw new GistError(res.status, `GitHub answered ${res.status}`);
    return res.json();
  }

  /** Finds the Comps gist (the one with the collection file), or creates it. */
  async findOrCreate() {
    for (let page = 1; page <= 5; page++) {
      const list = await this.req('GET', `/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.files && COLLECTION_FILE in g.files);
      if (hit) return (this.id = hit.id);
      if (list.length < 100) break;
    }
    const created = await this.req('POST', '/gists', {
      description: 'Comps collection — synced by the Comps app and website',
      public: false,
      files: { [COLLECTION_FILE]: { content: JSON.stringify({ v: 1, updatedAt: Date.now(), items: [] }) } },
    });
    return (this.id = created.id);
  }

  /** Reads the JSON files in the gist ({ name: object | null }). */
  async read() {
    const g = await this.req('GET', `/gists/${this.id}`);
    const out = {};
    for (const [name, f] of Object.entries(g.files ?? {})) {
      let text = f.content ?? '';
      if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { signal: AbortSignal.timeout(20000) })).text();
      try { out[name] = JSON.parse(text); } catch { out[name] = null; }
    }
    return out;
  }

  /** Writes only the given files; other files in the gist are untouched. */
  async write(files) {
    const payload = {};
    for (const [name, data] of Object.entries(files)) payload[name] = { content: JSON.stringify(data) };
    await this.req('PATCH', `/gists/${this.id}`, { files: payload });
  }
}
