/*
 * Panel account scope helper.
 *
 * Returns the Panel `account_id` from URL search params, or null when
 * running standalone (outside Panel). Used to namespace per-origin shared
 * resources so that two Panel windows opened for different accounts don't
 * collide:
 *
 *   - localStorage keys (LocalStorage.prefix in lib/localStorage.ts)
 *   - IndexedDB database names (config/databases/state.ts)
 *   - BroadcastChannel names (config/broadcastChannel.ts, config/app.ts)
 *   - sessionStorage 'xt_instance' singleton election
 *     (lib/singleInstance.ts — bypassed entirely in Panel mode)
 *
 * Sibling concern: SharedWorker. Even with all storage scoped, a shared
 * MTProto worker would multiplex two accounts through one auth_key. Panel
 * sidesteps this by appending `noSharedWorker=1` to the iframe URL on the
 * backend (web_login.py iframe_url builder), forcing each iframe to spawn
 * a dedicated Worker with its own MTProto state.
 *
 * In standalone mode (no `account_id` query param), all helpers behave as
 * no-ops so on-disk schema stays compatible with normal tweb users.
 */

let cached: string | null | undefined;

/**
 * Read account_id from the current global's URL once and cache it. Returns
 * null in standalone mode.
 *
 * `self` works in BOTH window and Worker contexts (Window inherits from it,
 * WorkerGlobalScope IS it). Without this, the helper read `window.location`
 * which doesn't exist in dedicated Workers — so worker-side calls returned
 * null and `panelScopedName('tweb-common')` produced the unscoped name. The
 * MTProto worker (lib/mainWorker/index.worker.ts) opens IndexedDB through
 * AppStorage / EncryptedStorageLayer, so without the worker seeing a real
 * accountId all iframes' workers would share `tweb-common` and the
 * per-account `tweb-account-1` slot — Telegram session blobs from one
 * account would surface in another iframe (verified live: opened
 * @TheresaWard866 with no cached session, iframe showed @Артем's chats
 * because his session was the last write to the unscoped DB).
 *
 * For workers to see account_id at all, the parent thread MUST append it
 * to the worker URL when constructing — see registerWorker /
 * registerCryptoWorker / registerThreadedWorker in apiManagerProxy.ts.
 */
export function getPanelAccountId(): string | null {
  if(cached === undefined) {
    try {
      // Iframe / Window context: read from URL search params (set by Panel
      // backend in the iframe URL — see web_login.py iframe_url builder).
      const fromSearch = new URLSearchParams(self.location.search).get('account_id');
      if(fromSearch) {
        cached = fromSearch;
      } else if(typeof (self as any).name === 'string' && (self as any).name.startsWith('panel-')) {
        // Worker context: parent thread passes account_id via the
        // WorkerOptions.name field when constructing the Worker (see
        // registerWorker in apiManagerProxy.ts). We can't use URL search
        // or hash because Vite's worker plugin requires the
        // `new URL(stringLiteral, import.meta.url)` pattern be inline
        // within `new Worker(...)` for build-time bundling — pre-building
        // the URL with mutated hash into a variable causes Vite to skip
        // bundling and serve the raw .ts source (404 at runtime).
        cached = (self as any).name.slice('panel-'.length) || null;
      } else {
        cached = null;
      }
    } catch(e) {
      cached = null;
    }
  }
  return cached;
}

/**
 * Suffix a base resource name with the Panel account_id when in Panel mode.
 * Returns the base name unchanged in standalone mode (preserves on-disk
 * compatibility for normal tweb users at web.telegram.org).
 *
 *   panelScopedName('tweb-common')         // 'tweb-common'                       (standalone)
 *   panelScopedName('tweb-common')         // 'tweb-common-panel-abc123'          (Panel mode)
 */
export function panelScopedName(base: string): string {
  const accountId = getPanelAccountId();
  return accountId ? `${base}-panel-${accountId}` : base;
}

/** Test-only — clear the module-level cache between test cases. */
export function _resetPanelAccountScopeForTesting(): void {
  cached = undefined;
}
