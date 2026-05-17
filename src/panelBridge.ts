/*
 * Panel Bridge — connects this tweb iframe to Panel API.
 * Initialized at boot from URL query params (?jwt=...&account_id=...&cached=...).
 * All other tweb code accesses the bridge via window.__panelBridge.
 *
 * Three methods rotate the internal JWT (single-use chain):
 *   onQrToken   → POSTs /v1/login/web/accept,   response gives jwt_for_cache
 *   getTwoFAPassword → GETs /v1/.../2fa-password, response gives jwt_for_next
 *   onSessionSaved  → POSTs /v1/login/web/cache, terminal (no new JWT)
 */

import { CACHE_STORAGE_DB_NAMES } from "@lib/files/cacheStorage";
import { getPanelAccountId } from "@lib/panelAccountScope";
import DeferredIsUsingPasscode from "@lib/passcode/deferredIsUsingPasscode";
import rootScope from "@lib/rootScope";
import sessionStorage from "@lib/sessionStorage";

export interface PanelSessionSnapshot {
  // Hex-encoded auth_key for the active DC (e.g. dc2_auth_key from AccountSessionData).
  authKeyHex: string;
  dcId: number;
  userId: number;
}

export interface ProxyConfig {
  // DC-agnostic wss:// URL that embeds the relay JWT.
  // Example: wss://panel.example.com/api/ws-relay/<account_id>/<dc>?jwt=<token>
  relayUrl: string;
}

export interface PanelBridgeAPI {
  readonly accountId: string;
  readonly cached: boolean;
  // Feature-detection: callers check bridge.capabilities.proxyRelay before
  // calling getProxyConfig / setProxyConfig / refreshProxyJwt.
  readonly capabilities: {proxyRelay: boolean};

  onQrToken(token: Uint8Array): Promise<{passwordPending: boolean}>;
  getTwoFAPassword(): Promise<string | null>;
  onSessionSaved(snapshot: PanelSessionSnapshot): Promise<void>;
  restoreCachedSession(): Promise<RestoreResult>;
  markCacheDead(): Promise<void>;
  setStage(stage: ProgressStage, detail: string): void;
  setError(message: string, opts?: {recoverable?: boolean}): void;
  onStateChange(cb: (s: ProgressState) => void): () => void;
  getState(): ProgressState;

  // WS-relay proxy config API (capabilities.proxyRelay === true).
  // getProxyConfig returns the current relay config (null if not yet received).
  getProxyConfig(): ProxyConfig | null;
  // setProxyConfig is called by the postMessage listener when panel posts
  // panel-bridge:set-relay-config or panel-bridge:relay-config.
  setProxyConfig(cfg: ProxyConfig): void;
  // refreshProxyJwt notifies the panel that the relay JWT has expired (close
  // code 4001). Panel will re-mint and respond with panel-bridge:relay-config.
  // Returns a promise that resolves when the new config has been received.
  refreshProxyJwt(): Promise<ProxyConfig>;
}

export type RestoreResult =
  | { success: true }
  | { success: false; code: "no_cache" | "network" | "unauthorized" };

export type PanelBridgeErrorCode =
  | "unauthorized"
  | "session_dead"
  | "no_cache"
  | "account_not_found"
  | "network";

export type ProgressStage = 1 | 2 | 3 | 4;

export interface ProgressState {
  stage: ProgressStage;
  detail: string;
  error: string | null;
  errorRecoverable: boolean;
}

export class PanelBridgeError extends Error {
  code: PanelBridgeErrorCode;

  constructor(code: PanelBridgeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PanelBridgeError";
  }
}

// Convert a hex string to Uint8Array (e.g. "deadbeef" → [0xDE, 0xAD, 0xBE, 0xEF]).
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Standard binary-to-base64 using btoa.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Standard base64-to-binary using atob.
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Convert a Uint8Array to lowercase hex string (e.g. [0xDE, 0xAD] → "dead").
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function mapStatusToCode(status: number): PanelBridgeErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "account_not_found";
  if (status === 410) return "session_dead";
  if (status === 422) return "no_cache";
  return "network";
}

class PanelBridge implements PanelBridgeAPI {
  readonly accountId: string;
  readonly cached: boolean;
  readonly capabilities = {proxyRelay: true};
  private currentJwt: string;
  private readonly origin: string;
  private _state: ProgressState = {
    stage: 1,
    detail: "Открываем сессию...",
    error: null,
    errorRecoverable: true,
  };
  private _listeners = new Set<(s: ProgressState) => void>();
  private _proxyConfig: ProxyConfig | null = null;
  // Pending refreshProxyJwt promise resolvers — resolved when panel responds.
  private _proxyRefreshResolvers: Array<{
    resolve: (cfg: ProxyConfig) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(accountId: string, cached: boolean, jwt: string, origin: string) {
    this.accountId = accountId;
    this.cached = cached;
    this.currentJwt = jwt;
    this.origin = origin;
    this._installPostMessageListener();
  }

  // Listen for relay config messages from the Panel SPA (parent window).
  // Handles two message types:
  //   panel-bridge:set-relay-config — initial config on iframe mount
  //   panel-bridge:relay-config     — fresh config after JWT refresh
  private _installPostMessageListener(): void {
    const panelOrigin = this.origin;
    window.addEventListener('message', (e: MessageEvent) => {
      if(e.origin !== panelOrigin) return;
      const data = e.data as {type?: string; proxyConfig?: ProxyConfig} | null;
      if(!data || typeof data !== 'object') return;
      if(
        data.type === 'panel-bridge:set-relay-config' ||
        data.type === 'panel-bridge:relay-config'
      ) {
        if(!data.proxyConfig) return;
        this._proxyConfig = data.proxyConfig;
        // Resolve any pending refreshProxyJwt promises.
        const resolvers = this._proxyRefreshResolvers.splice(0);
        for(const r of resolvers) {
          r.resolve(data.proxyConfig);
        }
      }
    });
  }

  getProxyConfig(): ProxyConfig | null {
    return this._proxyConfig;
  }

  setProxyConfig(cfg: ProxyConfig): void {
    this._proxyConfig = cfg;
  }

  refreshProxyJwt(): Promise<ProxyConfig> {
    // Notify the panel SPA that the relay JWT has expired.
    window.parent.postMessage({type: 'panel-bridge:relay-jwt-expired'}, this.origin);
    return new Promise<ProxyConfig>((resolve, reject) => {
      this._proxyRefreshResolvers.push({resolve, reject});
      // Safety timeout — if panel doesn't respond in 10 s, reject.
      setTimeout(() => {
        const idx = this._proxyRefreshResolvers.findIndex((r) => r.resolve === resolve);
        if(idx !== -1) {
          this._proxyRefreshResolvers.splice(idx, 1);
          reject(new Error('[panelBridge] refreshProxyJwt timed out'));
        }
      }, 10_000);
    });
  }

  async onQrToken(token: Uint8Array): Promise<{passwordPending: boolean}> {
    this.setStage(2, "Авторизация через Panel...");
    const tokenB64 = bytesToBase64(token);
    let res: Response;
    try {
      res = await fetch(`${this.origin}/v1/login/web/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jwt: this.currentJwt,
          token: tokenB64,
        }),
      });
    } catch (e) {
      throw new PanelBridgeError("network", `onQrToken network error: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new PanelBridgeError(
        mapStatusToCode(res.status),
        `onQrToken failed: ${res.status} ${res.statusText}`,
      );
    }
    const data = (await res.json()) as {jwt_for_cache: string; password_pending?: boolean};
    if (data.password_pending) {
      this.setStage(2, "Telegram запросил пароль 2FA...");
    }
    this.currentJwt = data.jwt_for_cache;
    return { passwordPending: !!data.password_pending };
  }

  async getTwoFAPassword(): Promise<string | null> {
    const url = `${this.origin}/v1/accounts/${this.accountId}/login/web/2fa-password?jwt=${encodeURIComponent(this.currentJwt)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET" });
    } catch (e) {
      throw new PanelBridgeError(
        "network",
        `getTwoFAPassword network error: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new PanelBridgeError(
        mapStatusToCode(res.status),
        `getTwoFAPassword failed: ${res.status} ${res.statusText}`,
      );
    }
    const data = (await res.json()) as {password: string | null; jwt_for_next: string};
    this.currentJwt = data.jwt_for_next;
    return data.password;
  }

  async onSessionSaved(snapshot: PanelSessionSnapshot): Promise<void> {
    const authKeyBytes = hexToBytes(snapshot.authKeyHex);
    const authKeyB64 = bytesToBase64(authKeyBytes);
    let res: Response;
    try {
      res = await fetch(`${this.origin}/v1/login/web/cache`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jwt: this.currentJwt,
          auth_key: authKeyB64,
          dc_id: snapshot.dcId,
          user_id: snapshot.userId,
        }),
      });
    } catch (e) {
      throw new PanelBridgeError(
        "network",
        `onSessionSaved network error: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new PanelBridgeError(
        mapStatusToCode(res.status),
        `onSessionSaved failed: ${res.status} ${res.statusText}`,
      );
    }
    // Terminal call — no JWT rotation.
    this.setStage(4, "Готово");
  }

  async restoreCachedSession(): Promise<RestoreResult> {
    console.warn(
      "[panelBridge] restoreCachedSession begin at",
      Date.now(),
      "cached=",
      this.cached,
      "accountId=",
      this.accountId,
    );
    if (!this.cached) {
      return { success: false, code: "no_cache" };
    }

    let res: Response;
    try {
      res = await fetch(
        `${this.origin}/v1/login/web/cache?jwt=${encodeURIComponent(this.currentJwt)}`,
        { method: "GET" },
      );
    } catch (e) {
      console.warn("[panelBridge] restoreCachedSession network error:", e);
      return { success: false, code: "network" };
    }

    if (res.status === 404 || res.status === 410) return { success: false, code: "no_cache" };
    if (res.status === 401 || res.status === 403) return { success: false, code: "unauthorized" };
    if (!res.ok) return { success: false, code: "network" };

    let data: {
      auth_key: string;
      dc_id: number;
      user_id: number;
      jwt_for_next: string;
    };
    try {
      data = await res.json();
    } catch (e) {
      console.warn("[panelBridge] restoreCachedSession json parse error:", e);
      return { success: false, code: "network" };
    }
    this.currentJwt = data.jwt_for_next;

    const authKeyBytes = base64ToBytes(data.auth_key);
    const authKeyHex = bytesToHex(authKeyBytes);

    await this._seedTwebAuthState({
      authKeyHex,
      dcId: data.dc_id,
      userId: data.user_id,
    });

    return { success: true };
  }

  // Called by tweb when MTProto restoration fails with the cached auth_key
  // (e.g. Telegram-side auth_key has been revoked, surfaced via rootScope's
  // 'logging_out' event). Tells the backend to drop the cached session so
  // the next /start returns cached=false and the operator gets a fresh
  // QR-flow. Best-effort — UX should not block on this call. Terminal —
  // server does not return a new JWT.
  async markCacheDead(): Promise<void> {
    if (!this.currentJwt) return;
    try {
      await fetch(`${this.origin}/v1/login/web/cache/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jwt: this.currentJwt }),
      });
    } catch (e) {
      console.warn("[panelBridge] markCacheDead failed", e);
    }
  }

  // Seeds tweb's localStorage so that when state-loading runs it sees a
  // logged-in account and skips QR-flow entirely. Writes both the primary
  // `account1` JSON (AccountSessionData) and the deprecated top-level keys
  // for legacy 'A'/'Z' versioning compatibility — different code paths in
  // tweb read from different places.
  //
  // ⚠️ Must write through @lib/sessionStorage (LocalStorageController),
  // NOT raw localStorage.setItem. The controller maintains an in-memory
  // cache (LocalStorage.cache at lib/localStorage.ts:35-61) that
  // tweb's state-loader and getNetworker (apiManager.ts:455-457) consult
  // before falling back to localStorage.getItem. Raw setItem bypasses
  // that cache and gets shadowed by the post-clear `undefined` value
  // that loadStateForAllAccountsOnce captured. See plan F-5 for the
  // cache-poisoning analysis.
  private async _seedTwebAuthState(snap: {
    authKeyHex: string;
    dcId: number;
    userId: number;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const fingerprint = snap.authKeyHex.slice(0, 8);

    // Primary — account1 JSON (AccountSessionData format).
    // dc{N}_auth_key holds the 512-char hex auth_key for the active DC.
    // Cast to any: TS can't statically verify the dynamic dc${N}_auth_key
    // key against AccountSessionData. Runtime shape is correct (verified
    // by tweb tests + the existing T-5 localStorage assertions).
    const accountData = {
      [`dc${snap.dcId}_auth_key`]: snap.authKeyHex,
      auth_key_fingerprint: fingerprint,
      userId: snap.userId,
      dcId: snap.dcId,
      date: now,
    } as any;

    await sessionStorage.set({ account1: accountData });

    // Deprecated keys — legacy 'A'/'Z' versioning compat.
    // ⚠️ user_auth uses 'dcID' (capital D, lowercase c, capital ID) —
    // verified in src/lib/accounts/accountController.ts:159.
    // dc{N}_auth_key at the top level lives in DeprecatedStorageValues
    // (lib/sessionStorage.ts:50-54). Cast to any for the dynamic key.
    await sessionStorage.set({
      user_auth: { date: now, id: snap.userId, dcID: snap.dcId } as any,
      dc: snap.dcId as any,
      auth_key_fingerprint: fingerprint,
      [`dc${snap.dcId}_auth_key`]: snap.authKeyHex,
    } as any);
  }

  setStage(stage: ProgressStage, detail: string): void {
    this._state = { stage, detail, error: null, errorRecoverable: true };
    this._notify();
  }

  setError(message: string, opts: {recoverable?: boolean} = {}): void {
    this._state = {
      ...this._state,
      error: message,
      errorRecoverable: opts.recoverable !== false,
    };
    this._notify();
  }

  onStateChange(cb: (s: ProgressState) => void): () => void {
    this._listeners.add(cb);
    cb(this._state);
    return () => {
      this._listeners.delete(cb);
    };
  }

  getState(): ProgressState {
    return this._state;
  }

  private _notify(): void {
    for (const cb of this._listeners) cb(this._state);
  }
}

let initialized = false;

// For unit tests only — resets the module-level `initialized` flag so that
// initPanelBridge() can be called again within the same test suite.
export function _resetPanelBridgeForTesting(): void {
  initialized = false;
  delete (window as any).__panelBridge;
}

// Tweb persists auth state in localStorage under these keys (see
// PATCH_RESEARCH.md). Across Panel modal opens for *different* accounts the
// iframe origin is the same → previous account's auth_key sticks around →
// tweb skips QR entirely and shows the wrong user. Wipe these before tweb's
// boot routing reads them so every modal open starts from a clean slate.
//
// Encrypted (passcode) storage uses IndexedDB and is NOT cleared here —
// Panel's flow assumes operator accounts have no passcode set.
const TWEB_AUTH_LOCALSTORAGE_KEYS = [
  "account1",
  "account2",
  "account3",
  "account4",
  "auth_key_fingerprint",
  "user_auth",
  "dc",
  // Per-DC auth_key blobs written by _seedTwebAuthState (and historically by
  // tweb's own AccountController). Without these, a previous account's
  // auth_key material persists at the iframe origin even after clearing
  // account{N}.
  "dc1_auth_key",
  "dc2_auth_key",
  "dc3_auth_key",
  "dc4_auth_key",
  "dc5_auth_key",
  "dc1_server_salt",
  "dc2_server_salt",
  "dc3_server_salt",
  "dc4_server_salt",
  "dc5_server_salt",
] as const;

function clearTwebAuthState(): void {
  // In Panel mode the LocalStorageController prefixes every key with
  // `panel-{accountId}-` (lib/localStorage.ts) so two iframes for
  // different accounts don't overwrite each other's auth on the shared
  // origin. Wipe with the same prefix here — otherwise we'd be deleting
  // unrelated keys (or no keys) and *this* iframe's stale auth would
  // survive into a fresh open of the same account.
  const accountId = getPanelAccountId();
  const prefix = accountId ? `panel-${accountId}-` : "";
  for (const key of TWEB_AUTH_LOCALSTORAGE_KEYS) {
    const fullKey = prefix + key;
    try {
      localStorage.removeItem(fullKey);
    } catch (e) {
      // localStorage can throw QuotaExceededError or be disabled in some
      // privacy modes. Swallow — worst case tweb sees stale state.
      console.warn("[panelBridge] localStorage.removeItem failed for", fullKey, e);
    }
  }
}

// One-time wipe of LEGACY UNSCOPED auth keys at the BARE name (no
// `panel-{accountId}-` prefix). Older builds of tweb (before the
// LocalStorageController prefixing landed) wrote these directly at the
// shared iframe origin — and they sit there forever because the current
// code never WRITES them anymore (so nothing overwrites or expires
// them) and clearTwebAuthState() above only deletes the prefixed
// names. Without this wipe, any code path that bypasses the
// LocalStorage prefix wrapper (raw localStorage.getItem fallback in
// the boot routing, certain account-restoration helpers) can read a
// foreign-account `account1` / `user_auth` and surface the wrong
// userId inside a freshly-loaded iframe (verified via browser
// forensic dump 2026-04-26: unscoped account1.userId belonged to no
// current scoped account). Run only once per iframe init.
function wipeLegacyUnscopedLocalStorage(): void {
  for (const key of TWEB_AUTH_LOCALSTORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      // localStorage can throw QuotaExceededError or be disabled in
      // some privacy modes. Swallow — worst case the legacy key stays
      // for one more boot.
      console.warn("[panelBridge] legacy localStorage.removeItem failed for", key, e);
    }
  }
}

// Tweb keeps additional state in IndexedDB (`tweb` and `tweb-common`
// databases). The 'tweb' DB carries the encrypted MTProto session blobs
// — without wiping it, a SharedWorker that re-attaches on the second
// modal open re-hydrates the previous session even after we cleared
// localStorage. Drop both databases on init for a fully clean slate.
async function clearTwebIndexedDB(): Promise<void> {
  // Match the scoped DB names produced by config/databases/state.ts —
  // otherwise we'd be issuing deleteDatabase against names that no
  // longer exist (no-op) while leaving *this* account's actual stale
  // sessions alive in the panel-scoped DBs.
  const accountId = getPanelAccountId();
  const suffix = accountId ? `-panel-${accountId}` : "";
  const dbNames = [`tweb${suffix}`, `tweb-common${suffix}`];

  // One-time migration: also wipe LEGACY unscoped DBs (`tweb`, `tweb-common`,
  // `tweb-account-1..4`). These were created by versions of the worker
  // before account_id was propagated through the worker URL hash — the
  // worker's panelScopedName() returned the unscoped base name and all
  // iframes' workers shared one set of DBs. After this commit the worker
  // sees account_id via self.location.hash and writes to scoped DBs only,
  // so the legacy unscoped ones are dead weight that would still poison
  // a fresh-account iframe whose worker tries to read from them on first
  // boot. Safe to delete unconditionally — standalone tweb users don't
  // run panelBridge.initPanelBridge so this code never executes for them.
  if (accountId) {
    for (let n = 1; n <= 4; n++) dbNames.push(`tweb-account-${n}`);
    dbNames.push("tweb", "tweb-common");
  }

  await Promise.all(
    dbNames.map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
            // Hard timeout — IndexedDB delete blocks if open connections exist
            // (typically the SharedWorker that hasn't released the DB yet).
            // Falling through after 500 ms is safer than hanging the whole
            // boot sequence.
            setTimeout(resolve, 500);
          } catch (e) {
            console.warn("[panelBridge] indexedDB.deleteDatabase failed for", name, e);
            resolve();
          }
        }),
    ),
  );
}

// One-time wipe of LEGACY UNSCOPED CacheStorage names (`cachedFiles`,
// `cachedStreamChunks`, `cachedAssets`, etc.). Older builds opened these
// at the bare name and shared them across Panel iframes — `cachedFiles`
// and `cachedStreamChunks` carry decrypted user media, so without this
// migration a fresh-account iframe would still see another account's
// media when the cache layer falls through to the legacy bare names.
// Only runs in panel mode (caller gates on getPanelAccountId() being
// non-null) so standalone tweb users at web.telegram.org keep their
// caches intact. Best-effort — caches.delete failures are ignored.
async function clearTwebLegacyCacheStorage(): Promise<void> {
  if (typeof caches === "undefined") return;
  await Promise.all(
    CACHE_STORAGE_DB_NAMES.map(async (name) => {
      try {
        await caches.delete(name);
      } catch (e) {
        console.warn("[panelBridge] caches.delete failed for legacy", name, e);
      }
    }),
  );
}

export interface InitPanelBridgeResult {
  panelMode: boolean;
  restorePromise: Promise<RestoreResult> | null;
}

// Returns {panelMode: true, restorePromise} if Panel params were present
// and the bridge was mounted on window.__panelBridge. Returns
// {panelMode: false, restorePromise: null} when running without Panel
// (normal tweb boot). Idempotent — subsequent calls are no-ops and
// return null restorePromise (caller should stash the original
// promise on first call).
export function initPanelBridge(): InitPanelBridgeResult {
  if (initialized) {
    return {
      panelMode: !!(window as any).__panelBridge,
      restorePromise: null,
    };
  }

  initialized = true;

  const params = new URLSearchParams(window.location.search);
  const jwt = params.get("jwt");
  const accountId = params.get("account_id");
  const cachedParam = params.get("cached");

  if (!jwt || !accountId) {
    return { panelMode: false, restorePromise: null };
  }

  // Diagnostic boot-time log. Kept on in production: when a panel-scope
  // leak does happen, this single line tells us which iframe (accountId),
  // which worker (self.name), and where it loaded from (href) — which
  // saves hours guessing during forensics.
  console.log(
    "[panelBridge] init:",
    "accountId=",
    getPanelAccountId(),
    "self.name=",
    (self as any).name,
    "href=",
    location.href,
  );

  // Defense in depth: wipe LEGACY UNSCOPED localStorage keys that older
  // builds wrote at the bare iframe origin. Only runs in panel mode (we
  // already returned above when accountId is missing) so standalone
  // tweb users at web.telegram.org keep their auth state intact.
  wipeLegacyUnscopedLocalStorage();

  // Clear any previous account's persisted auth before tweb's auth-routing
  // code at index.ts:518 reads localStorage. Without this, opening the
  // modal for account B inherits account A's session.
  clearTwebAuthState();

  // Fire IndexedDB cleanup as a background promise. Tweb's other boot
  // code that opens these DBs runs after IMAGE_MIME_TYPES_SUPPORTED_PROMISE
  // resolves (typically 100+ ms later), so the delete usually wins the
  // race. If it doesn't, the SharedWorker may re-hydrate the previous
  // session and the modal hangs on QR — operator can reopen.
  void clearTwebIndexedDB();

  // Same one-time migration for CacheStorage (cachedFiles /
  // cachedStreamChunks held decrypted user media at the unscoped name).
  // Background — no consumer awaits this.
  void clearTwebLegacyCacheStorage();

  const cached = cachedParam === "1";
  const origin: string =
    (import.meta.env && (import.meta.env as any).VITE_PANEL_ORIGIN) || "http://localhost:8000";

  const bridge = new PanelBridge(accountId, cached, jwt, origin);
  (window as any).__panelBridge = bridge;

  // Panel iframe assumes operator accounts have no passcode (see
  // TWEB_AUTH_LOCALSTORAGE_KEYS comment). Resolve early so subsequent
  // sessionStorage operations don't await on settings-load.
  DeferredIsUsingPasscode.resolveDeferred(false);
  console.warn(
    "[panelBridge] DeferredIsUsingPasscode resolved at",
    Date.now(),
    "accountId=",
    accountId,
  );

  // T-12 ROOT-CAUSE FIX (worker context bug):
  // The accountController.ts:90 gate (`window.__panelBridge`) throws
  // ReferenceError when AccountController.update is invoked inside the
  // SharedWorker (the typical post-QR path: apiManager.setUserAuth →
  // AccountController.update). The throw becomes a silent unhandled
  // rejection (apiManager.ts:247 doesn't await), so bridge.onSessionSaved
  // was never called from the worker path → POST /v1/login/web/cache
  // never fired → web_login_sessions stayed empty → every iframe open
  // re-required a QR scan.
  //
  // Workaround: listen on main-thread rootScope for 'user_auth'. Worker
  // dispatches 'user_auth' (apiManager.ts:240); apiManagerProxy.ts:343
  // forwards into the main-thread rootScope. By the time we hear it,
  // the worker's localStorage write (proxied through main thread) is
  // either complete or imminent — poll account1 briefly until all
  // bridge-required fields are present, then call bridge.onSessionSaved.
  installUserAuthBridgeListener(bridge);

  // Strategy B2 (per plan F-5) — kick off restoration in background;
  // pageProgress awaits the resulting promise. The seed via
  // sessionStorage.set (in restoreCachedSession → _seedTwebAuthState)
  // populates the LocalStorageController in-memory cache, so even though
  // tweb's loadStateForAllAccounts may have already run with empty data,
  // subsequent reads (state-loader, getNetworker) hit the seeded values.
  const restorePromise = cached ? bridge.restoreCachedSession() : null;

  return { panelMode: true, restorePromise };
}

// Returns true once bridge.onSessionSaved has fired successfully — the
// listener silently no-ops on subsequent events (cache write is terminal,
// JWT chain is consumed). Tracked per-bridge so a fresh init starts clean.
function installUserAuthBridgeListener(bridge: PanelBridgeAPI): void {
  let fired = false;

  rootScope.addEventListener("user_auth", async (userAuth: any) => {
    // Stale listener from a prior bridge instance (e.g. across tests or
    // re-inits) — bail. The current `__panelBridge` is the only one
    // whose JWT chain is live.
    if ((window as any).__panelBridge !== bridge) return;
    if (fired) return;

    // userAuth payload is UserAuth-shaped ({id, dcID, date}) when worker
    // dispatched it (apiManager.ts:240) or main-thread proxy fired it
    // (apiManagerProxy.ts:943). Can also be a bare UserId from
    // setUserAuth(user.id) calls. Extract id.
    let userId: number | undefined;
    if (typeof userAuth === "object" && userAuth !== null) {
      userId = Number((userAuth as { id?: number | string }).id);
    } else {
      const n = Number(userAuth);
      userId = isNaN(n) ? undefined : n;
    }
    if (!userId) return;

    // Worker writes account1 via the localStorage proxy. By the time the
    // 'user_auth' event has been forwarded into main-thread rootScope, the
    // proxied write is either done or imminent. Poll briefly until all
    // bridge-required fields settle (typically ≤ 1 tick).
    fired = true;
    const deadline = Date.now() + 1500;
    let snapshot: { dcId: number; authKeyHex: string; userId: number } | null = null;
    while (Date.now() < deadline) {
      // Re-check identity inside the loop — initPanelBridge is idempotent in
      // production, but tests (and any future hot-reload path) can replace
      // window.__panelBridge mid-poll. Calling onSessionSaved on the OLD
      // bridge would burn a JWT and surface as a phantom POST.
      if ((window as any).__panelBridge !== bridge) return;
      const data = (await sessionStorage.get("account1")) as any;
      if (data && data.dcId && data.userId) {
        const authKeyHex = data[`dc${data.dcId}_auth_key`];
        if (authKeyHex) {
          snapshot = {
            dcId: Number(data.dcId),
            authKeyHex: String(authKeyHex),
            userId: Number(data.userId),
          };
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!snapshot) {
      // Timed out — release the latch so a subsequent 'user_auth' event
      // (e.g. setBaseDcId fixup) can retry.
      fired = false;
      console.warn("[panelBridge] user_auth listener: timed out waiting for account1");
      return;
    }

    // Final identity check — the bridge could have been replaced during the
    // last poll iteration (between the loop check and the await).
    if ((window as any).__panelBridge !== bridge) return;

    try {
      await bridge.onSessionSaved(snapshot);
    } catch (e) {
      console.error("[panelBridge] onSessionSaved (main-thread listener) failed:", e);
      // Non-fatal — cache failure leaves the user functional but uncached.
      // Don't release the latch: the bridge JWT is single-use and a retry
      // would 401.
    }
  });
}
