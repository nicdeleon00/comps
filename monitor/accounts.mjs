// The monitor's view of Comps accounts (Supabase), using the service_role key —
// which can read everyone's drop links and write stock status. Keep that key on
// this computer only (monitor/config.json is git-ignored).

export class AccountsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Accounts {
  constructor(url, serviceKey) {
    this.url = String(url).replace(/\/$/, '');
    this.key = String(serviceKey).trim();
  }

  async req(method, path, body, prefer) {
    let res;
    try {
      res = await fetch(`${this.url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new AccountsError(0, `Couldn't reach Supabase: ${e.message}`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new AccountsError(401, 'Supabase refused the key. Run with --setup and paste the service_role key (Project Settings → API).');
    if (res.status === 404) throw new AccountsError(404, 'Tables not found. Run supabase/schema.sql in Supabase → SQL Editor first.');
    if (!res.ok) throw new AccountsError(res.status, `Supabase answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  watchItems() { return this.req('GET', 'watch_items?select=id,user_id,url,name,max_price&order=added_at.asc&limit=5000'); }
  devices() { return this.req('GET', 'push_devices?select=id,user_id,name,endpoint,p256dh,auth&limit=5000'); }
  statuses() { return this.req('GET', 'drop_status?select=*&limit=5000'); }
  monitorState() { return this.req('GET', 'monitor_state?select=*'); }
  upsertStatus(rows) { return rows.length ? this.req('POST', 'drop_status?on_conflict=watch_id', rows, 'resolution=merge-duplicates,return=minimal') : null; }
  addEvents(rows) { return rows.length ? this.req('POST', 'drop_events', rows, 'return=minimal') : null; }
  deleteDevice(id) { return this.req('DELETE', `push_devices?id=eq.${encodeURIComponent(id)}`); }
  heartbeat(row) { return this.req('POST', 'monitor_state?on_conflict=id', { id: 1, ...row }, 'resolution=merge-duplicates,return=minimal'); }
  pruneEvents(before) { return this.req('DELETE', `drop_events?at=lt.${Math.floor(before)}`); }
}
