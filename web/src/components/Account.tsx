import { useEffect, useState } from 'preact/hooks';
import { accountsEnabled, currentUser, onAuth, signIn, signUp, signOut, changePassword } from '../lib/supabase';
import { syncState, onSync, forgetLocalData } from '../lib/sync';
import { num } from '../lib/format';
import { toast } from './ui';

/** Re-renders when the signed-in account changes. */
export function useAccount() {
  const [user, setUser] = useState(currentUser);
  useEffect(() => onAuth(() => setUser(currentUser())), []);
  return user;
}

function useSyncState() {
  const [s, setS] = useState(syncState);
  useEffect(() => onSync(() => setS(syncState())), []);
  return s;
}

/** Sign in / create account, or — when signed in — sync status and account actions. */
export function AccountPanel({ compact = false }: { compact?: boolean }) {
  const user = useAccount();
  if (!accountsEnabled) {
    return (
      <div class="account-box">
        <div class="g-title">Accounts aren't switched on yet</div>
        <p class="g-desc">The site owner needs to connect Supabase (free). Until then your collection is saved in this browser.</p>
      </div>
    );
  }
  return user ? <SignedIn email={user.email} compact={compact} /> : <SignInForm />;
}

function SignInForm() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      if (mode === 'up') await signUp(email, password);
      else await signIn(email, password);
      toast(mode === 'up' ? 'Account created' : 'Signed in');
    } catch (x) {
      setErr((x as Error).message);
    }
    setBusy(false);
  };
  return (
    <form class="account-box" onSubmit={submit}>
      <div class="account-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'in'} class={mode === 'in' ? 'on' : ''} onClick={() => { setMode('in'); setErr(''); }}>Sign in</button>
        <button type="button" role="tab" aria-selected={mode === 'up'} class={mode === 'up' ? 'on' : ''} onClick={() => { setMode('up'); setErr(''); }}>Create account</button>
      </div>
      <p class="g-desc">{mode === 'up'
        ? 'Your collection, watchlist and drop alerts follow you to every device — the website and the iPhone app. Cards already in this browser are added to your new account.'
        : 'Use the same email and password as in the iPhone app.'}</p>
      <input class="input" type="email" autocomplete="email" placeholder="Email" value={email} required onInput={(e) => setEmail((e.target as HTMLInputElement).value)} aria-label="Email" />
      <input class="input" type="password" autocomplete={mode === 'up' ? 'new-password' : 'current-password'} placeholder={mode === 'up' ? 'Password (6+ characters)' : 'Password'} minLength={6} value={password} required
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)} aria-label="Password" />
      {err && <p class="account-err">{err}</p>}
      <button class="btn primary" disabled={busy || !email || password.length < 6}>{busy ? 'One moment…' : mode === 'up' ? 'Create account' : 'Sign in'}</button>
    </form>
  );
}

function SignedIn({ email, compact }: { email: string; compact: boolean }) {
  const s = useSyncState();
  const [changing, setChanging] = useState(false);
  const [pw, setPw] = useState('');
  return (
    <div class="account-box">
      <div class="account-who">
        <span class="account-avatar" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div class="g-title ellipsis">{email}</div>
          <div class="g-desc">
            {s.error ? <span style={{ color: 'var(--down)' }}>{s.error} · retrying automatically</span>
              : s.last ? `Syncs automatically · up to date${s.count != null ? ` · ${num(s.count)} card${s.count === 1 ? '' : 's'}` : ''}` : 'Syncing…'}
          </div>
        </div>
      </div>
      {!compact && (
        <div class="account-actions">
          <button class="btn sm" onClick={() => setChanging(!changing)}>Change password</button>
          <button class="btn sm" onClick={async () => {
            if (!confirm('Sign out? Your cards stay in your account; this browser forgets them until you sign in again.')) return;
            await signOut();
            forgetLocalData();
          }}>Sign out</button>
        </div>
      )}
      {changing && (
        <form class="account-actions" onSubmit={async (e) => {
          e.preventDefault();
          try { await changePassword(pw); setPw(''); setChanging(false); toast('Password changed'); } catch (x) { toast((x as Error).message); }
        }}>
          <input class="input sm" type="password" autocomplete="new-password" placeholder="New password (6+)" minLength={6} value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} style={{ maxWidth: 220 }} aria-label="New password" />
          <button class="btn primary sm" disabled={pw.length < 6}>Save</button>
        </form>
      )}
    </div>
  );
}
