/*
 * PanelBridge — integration layer between tweb iframe and Blitz Ads panel.
 *
 * Wire contracts (must match apps/api/src/panel_api/routers/web_login.py):
 *   POST /v1/login/web/accept        — body {jwt, token}    → {ok, jwt_for_cache, password_pending}
 *   POST /v1/login/web/cache         — body {jwt, auth_key, dc_id, user_id} → {ok}
 *   GET  /v1/login/web/cache?jwt=    →                       → {auth_key, dc_id, user_id, jwt_for_next}
 *   POST /v1/login/web/cache/revoke  — body {jwt}            → {ok}
 *   GET  /v1/accounts/{id}/login/web/2fa-password?jwt=       → {password, jwt_for_next}
 *
 * postMessage to window.parent (consumed by apps/web FloatingWindow + MobileActiveView):
 *   {type: 'panel-bridge:stage',          stage: 4,    windowId: accountId}
 *   {type: 'panel-bridge:auth-key-dead',               windowId: accountId}
 *
 * URL params on iframe src ($TWEB_ORIGIN/?jwt=...&cached=N&account_id=...&noSharedWorker=1):
 *   jwt           — single-use bridge JWT (HS256, intent=web-login-bridge, exp=+60s)
 *   account_id    — Keeper UUID; if absent → panelMode=false (standalone tweb)
 *   cached        — '1' if a non-revoked web_login_sessions row exists, '0' for QR flow
 *   noSharedWorker— forces dedicated Worker (multi-window-dock requirement)
 *
 * IMPORTANT gotchas (see panel-side .claude/rules/tweb.md):
 *   - sessionStorage writes MUST go through sessionStorage.set(...) — NEVER localStorage.setItem.
 *     LocalStorageController has in-memory cache; direct localStorage poisons it.
 *   - DeferredIsUsingPasscode.resolveDeferred(false) MUST be called early — without it
 *     sessionStorage.set hangs forever inside its passcode-gate await.
 *   - user_auth uses field name `dcID` (capital ID, Telegram legacy), NOT `dcId`.
 */

import sessionStorage from '@lib/sessionStorage';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import rootScope from '@lib/rootScope';
import bytesFromHex from '@helpers/bytes/bytesFromHex';
import bytesToBase64 from '@helpers/bytes/bytesToBase64';
import bytesToHex from '@helpers/bytes/bytesToHex';
import {parseUriParamsLine} from '@helpers/string/parseUriParams';

export type ProgressStage = 1 | 2 | 3 | 4;

export interface ProgressState {
  stage: ProgressStage;
  detail: string;
  error: string | null;
  errorRecoverable: boolean;
}

export type RestoreResult =
  | {success: true}
  | {success: false; code: 'no_cache' | 'network' | 'unauthorized'};

export interface SessionSnapshot {
  authKeyHex: string;
  dcId: number;
  userId: number;
}

interface InitPanelBridgeResult {
  panelMode: boolean;
  restorePromise: Promise<RestoreResult> | null;
}

interface CacheGetResponse {
  auth_key: string;
  dc_id: number;
  user_id: number;
  jwt_for_next: string;
}

interface AcceptResponse {
  ok: boolean;
  jwt_for_cache: string;
  password_pending: boolean;
}

interface TwoFAResponse {
  password: string | null;
  jwt_for_next: string;
}

// Default value for Vite-injected env. Production deploy passes
// VITE_PANEL_ORIGIN=http://<vps-ip>/api at build time (see deploy.yml).
const PANEL_API_ORIGIN_FALLBACK = 'http://localhost:8000';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getPanelApiOrigin(): string {
  const env = (import.meta as any).env?.VITE_PANEL_ORIGIN as string | undefined;
  if(env && env.length) return env;
  return PANEL_API_ORIGIN_FALLBACK;
}

/**
 * Wipe all tweb auth-state localStorage keys before injecting cached
 * credentials or running QR flow. Goes through sessionStorage.delete so the
 * LocalStorageController in-memory cache stays consistent.
 *
 * Without this, a stale `account1` from a previous browser session would
 * leak into the new iframe and either trigger a wrong-account login or
 * inject the wrong DC's auth_key.
 */
async function clearTwebAuthState(): Promise<void> {
  const keys = [
    'account1', 'account2', 'account3', 'account4',
    'auth_key_fingerprint',
    'user_auth',
    'dc',
    'dc1_auth_key', 'dc2_auth_key', 'dc3_auth_key', 'dc4_auth_key', 'dc5_auth_key',
    'dc1_server_salt', 'dc2_server_salt', 'dc3_server_salt', 'dc4_server_salt', 'dc5_server_salt',
    'dc1_hash', 'dc2_hash', 'dc3_hash', 'dc4_hash', 'dc5_hash'
  ] as const;
  await Promise.all(keys.map((k) => sessionStorage.delete(k as any).catch(() => {})));
}

/**
 * Drop tweb's IndexedDB databases so the next boot won't see stale dialog
 * state from a previous account. Fire-and-forget — if a DB is locked or
 * doesn't exist, the deleteDatabase call may hang or no-op; either way we
 * don't want to block the bridge boot.
 */
function clearTwebIndexedDB(): void {
  if(typeof indexedDB === 'undefined') return;
  const names = ['tweb', 'tweb-common', 'tweb-account-1', 'tweb-account-2', 'tweb-account-3', 'tweb-account-4'];
  for(const name of names) {
    try {
      indexedDB.deleteDatabase(name);
    } catch(e) {
      // ignore
    }
  }
}

/**
 * Inject a session snapshot into tweb's storage so that the next MTProto
 * request finds a valid auth_key without going through the QR flow.
 *
 * Uses sessionStorage.set (NOT localStorage.setItem) so the
 * LocalStorageController in-memory cache is updated alongside the browser
 * localStorage write. See panel-side .claude/rules/tweb.md § 1 for why this
 * matters.
 */
async function seedTwebAuthState(snap: SessionSnapshot): Promise<void> {
  await DeferredIsUsingPasscode.resolveDeferred(false);

  const dcKey = `dc${snap.dcId}_auth_key`;
  const fingerprint = snap.authKeyHex.slice(0, 8);
  const date = Math.floor(Date.now() / 1000);

  const updates: any = {
    [`account1`]: {
      [dcKey]: snap.authKeyHex,
      auth_key_fingerprint: fingerprint,
      userId: snap.userId,
      dcId: snap.dcId,
      date
    },
    auth_key_fingerprint: fingerprint,
    // Telegram legacy: capital `dcID`, not camelCase `dcId`.
    user_auth: {date, id: snap.userId, dcID: snap.dcId},
    dc: snap.dcId,
    [dcKey]: snap.authKeyHex
  };

  await sessionStorage.set(updates);
}

class PanelBridgeError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'PanelBridgeError';
  }
}

export class PanelBridge {
  public readonly accountId: string;
  public readonly cached: boolean;
  public readonly origin: string;
  private _currentJwt: string;
  private _state: ProgressState;
  private _listeners: Set<(s: ProgressState) => void> = new Set();
  private _userAuthFired = false;
  private _cacheDeadFired = false;

  constructor(accountId: string, cached: boolean, jwt: string, origin: string) {
    this.accountId = accountId;
    this.cached = cached;
    this._currentJwt = jwt;
    this.origin = origin;
    this._state = {
      stage: 1,
      detail: cached ? 'Открываем сессию...' : 'Подключаемся к Telegram...',
      error: null,
      errorRecoverable: true
    };
  }

  hasCachedSession(): boolean {
    return this.cached;
  }

  getState(): ProgressState {
    return {...this._state};
  }

  onStateChange(cb: (s: ProgressState) => void): () => void {
    this._listeners.add(cb);
    // Subscribe-emits-current: caller doesn't need a separate getState() call.
    try {
      cb({...this._state});
    } catch(e) {
      console.error('[panelBridge] onStateChange callback threw:', e);
    }
    return () => this._listeners.delete(cb);
  }

  setStage(stage: ProgressStage, detail: string): void {
    this._state = {stage, detail, error: null, errorRecoverable: true};
    this._notify();
    if(stage === 4) {
      this._postToParent({type: 'panel-bridge:stage', stage: 4, windowId: this.accountId});
    }
  }

  setError(message: string, opts?: {recoverable?: boolean}): void {
    this._state = {
      ...this._state,
      error: message,
      errorRecoverable: opts?.recoverable !== false
    };
    this._notify();
  }

  /**
   * Tweb has just exported a fresh QR login-token via auth.exportLoginToken.
   * Hand it to Panel which proxies auth.AcceptLoginToken through the farm.
   *
   * Caller (pageProgress.iterate) is responsible for dedup via bytesCmp so
   * the same token isn't POSTed on every poll cycle.
   */
  async onQrToken(token: Uint8Array): Promise<{passwordPending: boolean}> {
    this.setStage(2, 'Авторизация через Panel...');
    const body = {jwt: this._currentJwt, token: bytesToBase64(token)};
    let res: Response;
    try {
      res = await fetch(this.origin + '/v1/login/web/accept', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
      });
    } catch(e) {
      this.setError('Не удалось подключиться к Panel.');
      throw e;
    }
    if(!res.ok) {
      const text = await res.text().catch(() => '');
      this.setError('Panel отклонил QR-токен (' + res.status + ').');
      throw new PanelBridgeError(res.status, text);
    }
    const data = await res.json() as AcceptResponse;
    this._currentJwt = data.jwt_for_cache;
    if(data.password_pending) {
      this.setStage(2, 'Telegram запросил пароль 2FA...');
      return {passwordPending: true};
    }
    return {passwordPending: false};
  }

  /**
   * Pull Keeper-stored 2FA password for the current account. Called by
   * pagePassword's auto-fill hook after tweb mounted the pagePassword page
   * (Telegram emitted SESSION_PASSWORD_NEEDED or loginTokenPassword).
   *
   * Returns null when no password is stored — caller falls back to manual.
   */
  async getTwoFAPassword(): Promise<string | null> {
    const url = this.origin + '/v1/accounts/' + this.accountId +
      '/login/web/2fa-password?jwt=' + encodeURIComponent(this._currentJwt);
    let res: Response;
    try {
      res = await fetch(url, {method: 'GET'});
    } catch(e) {
      console.error('[panelBridge] getTwoFAPassword network failed:', e);
      return null;
    }
    if(res.status === 404) return null;
    if(!res.ok) {
      console.warn('[panelBridge] getTwoFAPassword status', res.status);
      throw new PanelBridgeError(res.status, await res.text().catch(() => ''));
    }
    const data = await res.json() as TwoFAResponse;
    this._currentJwt = data.jwt_for_next;
    return data.password;
  }

  /**
   * Tweb just persisted account1 with a populated auth_key — snapshot it
   * to Panel so the next cached re-mount skips QR entirely.
   *
   * Latched: only fires once per bridge lifetime. Tweb's accountController
   * can call update(1, ...) multiple times during a single auth flow
   * (initial save, fillMissingData replay, account-switching updates) but
   * we only need to write the cache once — subsequent calls are no-ops.
   */
  async onSessionSaved(snap: SessionSnapshot): Promise<void> {
    if(this._userAuthFired) return;
    this._userAuthFired = true;

    const authKeyBytes = bytesFromHex(snap.authKeyHex);
    const body = {
      jwt: this._currentJwt,
      auth_key: bytesToBase64(authKeyBytes),
      dc_id: snap.dcId,
      user_id: snap.userId
    };

    try {
      const res = await fetch(this.origin + '/v1/login/web/cache', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
      });
      if(!res.ok) {
        console.warn('[panelBridge] onSessionSaved POST /cache returned', res.status);
        // Non-fatal: tweb's auth-flow is already done locally.
      }
      // Stage 4 + parent postMessage — Panel hides the ProgressBar overlay
      // and starts trusting the iframe as a live session.
      this.setStage(4, 'Готово');
    } catch(e) {
      console.error('[panelBridge] onSessionSaved network failed:', e);
      // Still mark stage 4 — local auth succeeded, only the cache write
      // failed. Operator can re-open the window to retry the cache write.
      this.setStage(4, 'Готово');
    }
  }

  /**
   * On the cached path: pull the encrypted auth_key from Panel and inject
   * it into tweb's sessionStorage so MTProto wakes up authenticated.
   */
  async restoreCachedSession(): Promise<RestoreResult> {
    this.setStage(1, 'Восстанавливаем сессию...');
    const url = this.origin + '/v1/login/web/cache?jwt=' + encodeURIComponent(this._currentJwt);
    let res: Response;
    try {
      res = await fetch(url, {method: 'GET'});
    } catch(e) {
      console.error('[panelBridge] restoreCachedSession network failed:', e);
      this.setError('Нет связи с Panel — повторите позже.', {recoverable: true});
      return {success: false, code: 'network'};
    }
    if(res.status === 401 || res.status === 403) {
      this.setError('JWT отклонён Panel — закройте окно и откройте заново.', {recoverable: false});
      return {success: false, code: 'unauthorized'};
    }
    if(res.status === 404 || res.status === 410) {
      // Panel says no cache — caller (pageProgress.iterateRestore) should
      // not retry. The operator needs a fresh QR-flow which currently
      // requires reopening the window with cached=0.
      this.setError('Кеш сессии устарел — закройте окно и откройте заново.', {recoverable: false});
      return {success: false, code: 'no_cache'};
    }
    if(!res.ok) {
      this.setError('Panel вернул ошибку ' + res.status + '.', {recoverable: true});
      return {success: false, code: 'network'};
    }

    let data: CacheGetResponse;
    try {
      data = await res.json() as CacheGetResponse;
    } catch(e) {
      this.setError('Невалидный ответ Panel.', {recoverable: true});
      return {success: false, code: 'network'};
    }
    this._currentJwt = data.jwt_for_next;

    try {
      const authKeyBytes = base64ToBytes(data.auth_key);
      if(authKeyBytes.length !== 256) {
        this.setError('Panel вернул auth_key неверного размера.', {recoverable: false});
        return {success: false, code: 'no_cache'};
      }
      const authKeyHex = bytesToHex(authKeyBytes);
      await seedTwebAuthState({authKeyHex, dcId: data.dc_id, userId: data.user_id});
    } catch(e) {
      console.error('[panelBridge] seedTwebAuthState failed:', e);
      this.setError('Не удалось записать сессию в браузер.', {recoverable: true});
      return {success: false, code: 'network'};
    }

    this.setStage(3, 'Загружаем чаты...');
    return {success: true};
  }

  /**
   * Mark the cached session dead. Called when:
   *   - tweb's MTProto layer hit AUTH_KEY_INVALID / AUTH_KEY_UNREGISTERED /
   *     SESSION_EXPIRED / SESSION_REVOKED and dispatched 'logging_out'
   *   - restoreCachedSession returned 'unauthorized'
   *
   * Idempotent on both client and server side. Latched here so duplicate
   * 'logging_out' events (e.g. when both pageProgress listener and global
   * listener fire) only POST once.
   */
  async markCacheDead(): Promise<void> {
    if(this._cacheDeadFired) return;
    this._cacheDeadFired = true;

    // Tell the host page to close the window + toast the operator. Do this
    // BEFORE the await so the UX feels instant even if /cache/revoke is slow.
    this._postToParent({type: 'panel-bridge:auth-key-dead', windowId: this.accountId});

    try {
      await fetch(this.origin + '/v1/login/web/cache/revoke', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jwt: this._currentJwt})
      });
    } catch(e) {
      console.warn('[panelBridge] markCacheDead /cache/revoke failed:', e);
    }
  }

  private _notify(): void {
    const snapshot = {...this._state};
    for(const cb of this._listeners) {
      try {
        cb(snapshot);
      } catch(e) {
        console.error('[panelBridge] listener threw:', e);
      }
    }
  }

  private _postToParent(payload: any): void {
    try {
      if(window.parent && window.parent !== window) {
        // Use '*' as target origin: payload contains no secrets (just stage
        // number / windowId), and Panel host validates `e.origin` against
        // TWEB_ORIGIN before accepting. Restricting target origin requires
        // either VITE_PANEL_HOST_ORIGIN at build time or location.ancestorOrigins,
        // neither of which is reliably available across all browsers.
        window.parent.postMessage(payload, '*');
      }
    } catch(e) {
      console.warn('[panelBridge] postMessage to parent failed:', e);
    }
  }
}

/**
 * Boot-time entry point. Called from src/index.ts at module top-level
 * (NOT inside DOMContentLoaded — needs to mount window.__panelBridge
 * before pages start initializing).
 *
 * Returns panelMode=false in standalone tweb (no jwt URL param) so the
 * existing auth-state switch runs untouched.
 */
export function initPanelBridge(): InitPanelBridgeResult {
  let params: ReturnType<typeof parseUriParamsLine>;
  try {
    params = parseUriParamsLine(location.search.slice(1));
  } catch(e) {
    return {panelMode: false, restorePromise: null};
  }

  const jwt = params.jwt as string | undefined;
  const accountId = params.account_id as string | undefined;
  if(!jwt || !accountId) {
    return {panelMode: false, restorePromise: null};
  }
  const cached = params.cached === '1';

  // Critical: without this, sessionStorage.set() awaits indefinitely on the
  // passcode-gate deferred. tweb's standard boot resolves this after
  // passcode checks; we have no passcode in panel mode.
  DeferredIsUsingPasscode.resolveDeferred(false);

  // Wipe stale tweb state synchronously (sessionStorage cache + localStorage)
  // BEFORE constructing the bridge. The IDB clear is fire-and-forget.
  const wipePromise = clearTwebAuthState();
  clearTwebIndexedDB();

  const bridge = new PanelBridge(accountId, cached, jwt, getPanelApiOrigin());
  (window as any).__panelBridge = bridge;

  // Global logging_out listener — fires postMessage + /cache/revoke even
  // if pageProgress has already mounted pageIm (Page.installPromise is
  // memoized; pageProgress's own listener may not be live by then).
  rootScope.addEventListener('logging_out', () => {
    void bridge.markCacheDead();
  });

  let restorePromise: Promise<RestoreResult> | null = null;
  if(cached) {
    // Chain restore after the synchronous wipe so we don't race the
    // delete + set of the same localStorage keys.
    restorePromise = wipePromise.then(() => bridge.restoreCachedSession());
  }

  return {panelMode: true, restorePromise};
}

export default initPanelBridge;
