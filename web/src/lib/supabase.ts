// Accounts: email + password sign-in and per-person data, through Supabase's
// plain HTTP APIs (no SDK, so the site stays small). The project URL and anon
// key are public by design; row-level security keeps each person's rows private.

const BASE = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '').replace(/\/$/, '');
const ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

/** False until the site owner adds the Supabase settings. */
export const accountsEnabled = Boolean(BASE && ANON);

export type User = { id: string; email: string };
type Session = { access_token: string; refresh_token: string; expires_at: number; user: User };

const SESSION_KEY = 'comps.session';
const listeners = new Set<() => void>();

function currentSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null; } catch { return null; }
}
export const currentUser = (): User | null => currentSession()?.user ?? null;

function store(s: Session | null) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
  listeners.forEach((l) => l());
}
export function onAuth(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function friendly(status: number, body: any): string {
  const raw = String(body?.error_description ?? body?.msg ?? body?.message ?? body?.error ?? '').trim();
  if (/invalid login credentials/i.test(raw)) return 'That email and password don’t match an account.';
  if (/already registered|already exists/i.test(raw)) return 'There’s already an account with that email. Sign in instead.';
  if (/password should be at least/i.test(raw)) return 'Use a password with at least 6 characters.';
  if (/email not confirmed/i.test(raw)) return 'Confirm your email first (check your inbox).';
  if (/rate limit|too many/i.test(raw)) return 'Too many tries — wait a minute and try again.';
  if (/limit reached/i.test(raw)) return raw.replace(/^.*Limit reached:/i, 'Limit reached:');
  return raw || `Something went wrong (${status}).`;
}

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${init.token ?? ANON}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new AccountError(0, 'Couldn’t reach the account server. Check your connection.');
  }
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new AccountError(res.status, friendly(res.status, body));
  return body;
}

function toSession(b: any): Session {
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: b.expires_at ?? Math.floor(Date.now() / 1000) + (b.expires_in ?? 3600),
    user: { id: b.user?.id, email: b.user?.email ?? '' },
  };
}

export async function signUp(email: string, password: string) {
  const b = await call('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
  if (!b?.access_token) throw new AccountError(200, 'Account created — confirm your email, then sign in.');
  store(toSession(b));
}

export async function signIn(email: string, password: string) {
  store(toSession(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) })));
}

export async function signOut() {
  const s = currentSession();
  store(null);
  if (s) call('/auth/v1/logout', { method: 'POST', token: s.access_token }).catch(() => {});
}

export async function changePassword(password: string) {
  await call('/auth/v1/user', { method: 'PUT', token: await accessToken(), body: JSON.stringify({ password }) });
}

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshed when it's about to expire. */
async function accessToken(): Promise<string> {
  const s = currentSession();
  if (!s) throw new AccountError(401, 'Sign in first.');
  if (s.expires_at - Date.now() / 1000 > 60) return s.access_token;
  refreshing ??= (async () => {
    try {
      const b = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: s.refresh_token }) });
      const next = toSession(b);
      store(next);
      return next.access_token;
    } catch (e) {
      // A refresh token that no longer works means signing in again.
      if (e instanceof AccountError && e.status >= 400 && e.status < 500) store(null);
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Data API read anyone can make, signed in or not (for public tables). */
export const publicRest = <T = any>(path: string): Promise<T> => call(`/rest/v1/${path}`) as Promise<T>;

/** Data API call as the signed-in person (row-level security applies). */
export async function rest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  return call(`/rest/v1/${path}`, { ...init, token: await accessToken() }) as Promise<T>;
}

export const rpc = <T = any>(fn: string, args: unknown) => rest<T>(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
