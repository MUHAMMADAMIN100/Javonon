import { create } from 'zustand';
import type { User } from '../api/types';
import { login as apiLogin, me as apiMe } from '../api/auth';
import { connectRealtime, disconnectRealtime } from '../realtime';
import { queryClient } from '../lib/queryClient';

const TOKEN_KEY = 'javonon_token';
const ME_CACHE_KEY = 'javonon_me_cache';

/**
 * How long bootstrap() waits for /auth/me before flipping ready:true with
 * whatever user we could seed synchronously (cached /auth/me or minimal
 * JWT claims). Chosen small enough that a Railway cold-start / bad wifi
 * doesn't strand the manager on <Loading fullscreen /> for the axios
 * timeout (60s — see api/client.ts), and large enough that a warm request
 * still wins the race so we never render a stale profile.
 */
const BOOTSTRAP_ME_SOFT_TIMEOUT_MS = 2000;

/** Sentinel resolved by the soft-timeout arm of the bootstrap race. */
const TIMEOUT_SIGNAL = '__bootstrap_me_timeout__' as const;

/**
 * Read the JWT from localStorage first, then sessionStorage.
 * Session-storage lookup is a migration path — earlier versions of the CRM
 * put the token there when «Запомнить меня» was unchecked. That checkbox is
 * gone now (staff/founder auth is always persistent), so we sweep any lingering
 * session token into localStorage in bootstrap().
 */
export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Private mode / storage disabled — treat as anonymous.
    return null;
  }
}

/**
 * Typed error the login flow throws when the token could NOT be persisted
 * (QuotaExceededError, private-mode restrictions, corrupt storage partition).
 * The Login page inspects this to render a specific message in the error
 * banner instead of falling through to the generic «Не удалось войти» — see
 * the stuck-login-loop bug where a swallowed writeToken() failure led to
 * dashboard → 401 → back-to-login with no explanation.
 */
export class TokenStorageError extends Error {
  readonly code = 'TOKEN_STORAGE_UNAVAILABLE' as const;
  constructor(
    message = 'Не удалось сохранить сессию. Разрешите хранилище сайту и повторите вход.',
  ) {
    super(message);
    this.name = 'TokenStorageError';
  }
}

/**
 * Always writes to localStorage; wipes any lingering copy in sessionStorage.
 *
 * Returns `true` on success, `false` if localStorage.setItem threw
 * (QuotaExceededError / private-mode / storage disabled). Callers on the
 * login path MUST check the return value and surface a typed error — see
 * TokenStorageError above and the store's login() below.
 *
 * The sessionStorage cleanup is best-effort: if it fails after a successful
 * localStorage write we still return true (the login is usable; the legacy
 * session-storage copy just lingers until next logout).
 */
export function writeToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return false;
  }
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop — legacy sweep */ }
  return true;
}

/** Remove the token from BOTH storages (defensive — legacy zombies). */
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

/**
 * Offline-first cache of the last successful /auth/me. Seeded into the
 * store on bootstrap() so the app renders the real profile (fullName,
 * permissions, customRole) immediately even when the API is slow or the
 * device is offline. The freshest fetch overwrites this on success and
 * flips `hydrated:true`; the cache itself never flips `hydrated` (it may
 * be stale — a role change made server-side won't be reflected until
 * /auth/me answers).
 */
function readMeCache(): User | null {
  try {
    const raw = localStorage.getItem(ME_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

function writeMeCache(user: User): void {
  try { localStorage.setItem(ME_CACHE_KEY, JSON.stringify(user)); } catch { /* storage unavailable */ }
}

function clearMeCache(): void {
  try { localStorage.removeItem(ME_CACHE_KEY); } catch { /* noop */ }
}

interface AuthState {
  user: User | null;
  /** True once bootstrap() has finished (success OR failure). App renders
   *  a full-screen loader while this is false — never a login flash. */
  ready: boolean;
  /** @deprecated Backwards-compatible alias for `ready`. Legacy code paths
   *  read `initialized`; new code should prefer `ready`. */
  initialized: boolean;
  /**
   * True only when `user` came from `/auth/me` (has fullName, permissions,
   * customRole). Distinct from `ready`: on Railway cold-start (503/504/timeout)
   * bootstrap() still flips `ready` so the app is usable, but leaves
   * `hydrated=false` while the store holds only a minimal JWT-claims stub.
   *
   * Any permission/menu-gated UI (Sidebar, RoleSwitcher, custom-role checks)
   * MUST render a skeleton until this flips, otherwise a FOUNDER whose JWT
   * lacks the `role` claim collapses into the SALES_MANAGER menu and loses
   * /settings, /users, /finance, etc.; a custom-role user renders with
   * `hasCustomRole=false` and gets the wrong base-role menu.
   */
  hydrated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  bootstrap: () => Promise<void>;
  /** @deprecated Backwards-compatible alias for `bootstrap`. */
  init: () => Promise<void>;
}

/**
 * QA-fix: decode the JWT client-side so we know our own `sub` even before
 * /auth/me has answered (Railway cold-start can add 1-2s). Without this,
 * `me?.id` was null and the chat put every message in the `isMine=false`
 * branch — own messages ended up on the left.
 */
function decodeJwt(token: string): { sub?: string; email?: string; role?: string; roles?: string[] } | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Backoff schedule for /auth/me retries during bootstrap(). Railway cold-start
 * commonly returns 503/504 for the first hit and then answers within a couple
 * of seconds. Total worst-case wait: ~3s — much better than shipping the
 * app with a half-hydrated JWT-claims stub for the rest of the session,
 * which silently downgrades a FOUNDER to the SALES_MANAGER menu.
 *
 * If every retry still fails with a non-401, bootstrap() flips `ready` (so the
 * user isn't stranded on <Loading fullscreen />) but leaves `hydrated=false`;
 * menu-gated UI must render a skeleton off that flag.
 */
const ME_RETRY_DELAYS_MS = [500, 1000, 1500];

/** Discriminated result of `fetchMeWithRetries`, normalised so bootstrap()
 *  can branch on 401 vs 5xx/network without a try/catch pyramid. */
type MeResult = { ok: true; user: User } | { ok: false; err: any };

/**
 * Fetch /auth/me with the ME_RETRY_DELAYS_MS backoff — 4 attempts total.
 * Never throws; returns a MeResult.
 *
 * 401 short-circuits the loop: retrying a bad token is pointless (and each
 * failed attempt causes the axios interceptor to fire another
 * clearToken()+redirect). Every other error (network / 5xx / timeout /
 * response-less axios error) is worth another attempt on Railway cold-start.
 */
async function fetchMeWithRetries(): Promise<MeResult> {
  let lastErr: any = null;
  for (let attempt = 0; attempt <= ME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return { ok: true, user: await apiMe() };
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (status === 401) return { ok: false, err: e };
      // 4xx (non-401) also won't fix itself on retry — bail early.
      if (status !== undefined && status < 500) break;
      if (attempt >= ME_RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, ME_RETRY_DELAYS_MS[attempt]));
    }
  }
  return { ok: false, err: lastErr };
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  initialized: false,
  hydrated: false,

  async login(email, password) {
    const { token, user } = await apiLogin(email, password);
    // Staff/founder auth is always persistent — no more «Запомнить меня»
    // checkbox. Everyone gets localStorage.
    //
    // If persistence fails (QuotaExceededError, private-mode restrictions,
    // corrupt storage partition) we MUST abort here: setting `user` would
    // navigate the UI to /dashboard, then the very next API request goes
    // out without an Authorization header (readToken() returns null), the
    // backend answers 401, the response-interceptor bounces back to
    // /admin/login — and the manager sees an unexplained «form works,
    // dashboard flashes, then login again» loop. Throw a typed error so
    // the Login page can render an actionable message in the error banner.
    if (!writeToken(token)) {
      throw new TokenStorageError();
    }
    // Belt-and-suspenders: wipe any anonymous/previous-user data that may
    // still be resident in the QueryClient (gcTime = 5min). Without this,
    // a same-session logout→login sees the previous user's cached queries
    // (assignedApplications, my-tasks, chat rooms, notifications, /auth/me)
    // return synchronously as isPending:false before the background refetch.
    queryClient.clear();
    // Warm the offline-first cache so the next bootstrap() can soft-render
    // the real profile without waiting on /auth/me. Cheap and safe: the
    // login response is as fresh as /auth/me by construction.
    writeMeCache(user);
    connectRealtime(token);
    // Login response carries the full user, so we are fully hydrated by
    // definition. Sidebar/permission gates flip off their skeleton on this.
    set({ user, hydrated: true });
  },

  logout() {
    clearToken();
    // Also nuke the /auth/me cache — otherwise a same-browser logout→login
    // as a different user would seed the login screen (or the next
    // bootstrap) with the previous user's fullName/permissions.
    clearMeCache();
    disconnectRealtime();
    // Drop every cached query so user-A's data can't leak into user-B's
    // session on same-browser logout→login. staleTime is 30s and gcTime is
    // 5min (see lib/queryClient.ts), so without this the next user briefly
    // sees the previous user's applications/tasks/chat/notifications from
    // cache before the refetch lands — same class of bug as the isMine one
    // that the comment on queryClient.ts:10 references.
    queryClient.clear();
    set({ user: null, hydrated: false });
  },

  async bootstrap() {
    const token = readToken();
    if (!token) {
      set({ user: null, ready: true, initialized: true, hydrated: false });
      return;
    }

    // Session→local migration: if we picked up the token from sessionStorage,
    // consolidate it into localStorage so future opens hit the fast path and
    // the token survives a browser restart.
    //
    // Return value intentionally ignored: unlike the login path we don't need
    // to surface a hard error here. If persistence fails the token still lives
    // in sessionStorage (readToken() falls back to it), the current tab keeps
    // working, and the migration simply retriggers on the next reload — a
    // benign no-op loop, not a login bounce.
    writeToken(token);

    // Minimal user from JWT claims — lets chat/UI have `me.id` immediately
    // while /auth/me is in-flight (see decodeJwt() comment above).
    //
    // NOTE: this stub has NO fullName, NO permissions, NO customRole, and
    // `role` falls back to SALES_MANAGER when the claim is absent. Anything
    // that gates on role/permissions (Sidebar menu, RoleSwitcher) MUST wait
    // for `hydrated=true` before rendering — otherwise a FOUNDER whose JWT
    // lacks the claim collapses into the SALES_MANAGER menu and loses
    // /settings, /users, /finance, etc. See AuthState.hydrated doc.
    const claims = decodeJwt(token);
    if (claims?.sub) {
      set({
        user: {
          id: claims.sub,
          email: claims.email || '',
          fullName: '',
          role: (claims.role as any) || 'SALES_MANAGER',
          roles: (claims.roles as any) || [],
        } as User,
      });
      connectRealtime(token);
    }

    // Race /auth/me (with retries) against a soft timer. Before this fix
    // bootstrap() awaited fetchMeWithRetries() unconditionally — with axios
    // timeout=60s and up to 4 attempts the manager could be stranded on
    // <Loading fullscreen /> for tens of seconds on a Railway cold-start or
    // flaky mobile connection. Now: if the timer wins first we flip
    // ready:true with the JWT-stub user on screen (chat/UI already work —
    // that was the whole point of the decodeJwt() seed above) and finish
    // /auth/me in the background. `hydrated` stays false while we're in the
    // provisional state, so any permission-gated UI (Sidebar, RoleSwitcher)
    // shows a skeleton — that skeleton doubles as the "still validating…"
    // cue so the manager knows the profile on screen isn't final.
    const meResultPromise: Promise<MeResult> = fetchMeWithRetries();
    const timerPromise: Promise<typeof TIMEOUT_SIGNAL> = new Promise((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SIGNAL), BOOTSTRAP_ME_SOFT_TIMEOUT_MS);
    });

    /**
     * Apply the resolved /auth/me result to the store. When
     * `alreadyReady=true` the ready/initialized flags were flipped in the
     * soft-render step and we must NOT re-flip them here (would cause a
     * spurious re-render of the entire app tree — Sidebar, tables, etc.).
     *
     * The three outcomes mirror the pre-race branches:
     * - ok:         write cache, connect realtime, set fresh user +
     *               hydrated:true (Sidebar/menu drop their skeleton).
     * - 401:        real auth-fail — nuke token+cache; the axios 401
     *               interceptor (see api/client.ts) has already fired a
     *               full-page redirect to /admin/login, this set() just
     *               keeps the store consistent for the interstitial frame.
     * - 5xx/net:    keep whatever is currently on screen (JWT stub OR the
     *               offline cache we swap in below) so a prolonged Railway
     *               outage doesn't kick the manager back to login. hydrated
     *               follows the source: cache → true (stale-but-real menu
     *               is strictly better than a wrong JWT-stub menu), stub →
     *               false (Sidebar renders a skeleton, per hydrated doc).
     */
    const applyMeResult = (result: MeResult, alreadyReady: boolean): void => {
      if (result.ok) {
        connectRealtime(token);
        writeMeCache(result.user);
        set(alreadyReady
          ? { user: result.user, hydrated: true }
          : { user: result.user, ready: true, initialized: true, hydrated: true });
        return;
      }
      const status = result.err?.response?.status;
      if (status === 401) {
        clearToken();
        clearMeCache();
        set(alreadyReady
          ? { user: null, hydrated: false }
          : { user: null, ready: true, initialized: true, hydrated: false });
        return;
      }
      // 5xx / network, even after retries. Try the offline cache so we can
      // render the real Sidebar with the last-known role/permissions instead
      // of the JWT-claims stub. The cache may be stale (a role change made
      // while offline won't be reflected), but it's strictly better than the
      // stub — which silently downgrades a FOUNDER to the SALES_MANAGER menu.
      const cached = readMeCache();
      if (cached) {
        connectRealtime(token);
        set(alreadyReady
          ? { user: cached, hydrated: true }
          : { user: cached, ready: true, initialized: true, hydrated: true });
      } else if (!alreadyReady) {
        set({ ready: true, initialized: true, hydrated: false });
      }
      // If alreadyReady and no cache: keep the JWT stub on screen with
      // hydrated:false — no set() needed, nothing to change.
    };

    const winner = await Promise.race([meResultPromise, timerPromise]);

    if (winner === TIMEOUT_SIGNAL) {
      // Soft-render: unstick the loader with the JWT-stub user on screen
      // and finish /auth/me in the background. When it resolves,
      // applyMeResult() merges the fresh profile (or the cache, or clears
      // the session on 401) in place.
      set({ ready: true, initialized: true });
      // fetchMeWithRetries() never rejects, but connectRealtime()/JSON.stringify
      // in the applyMeResult callback conceivably could — swallow so we don't
      // leave an unhandled-rejection in the console after a soft-render.
      void meResultPromise
        .then((result) => applyMeResult(result, true))
        .catch(() => { /* nothing sensible to recover here — user stays soft-rendered */ });
      return;
    }

    applyMeResult(winner, false);
  },

  async init() {
    // Alias kept for legacy callers (App.tsx used to call init()).
    await get().bootstrap();
  },
}));
