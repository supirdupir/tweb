/*
 * Panel iframe progress page — replaces pageSignQR when running inside
 * Panel modal (window.__panelBridge present). Renders a linear progress
 * bar driven by bridge state, runs the auth.exportLoginToken poll loop
 * (ported from pageSignQR.ts), mounts pagePassword on 2FA / pageIm on success.
 */
import type {DcId} from '@types';
import Page from '@/pages/page';
import {AuthAuthorization, AuthLoginToken} from '@layer';
import App from '@config/app';
import rootScope from '@lib/rootScope';
import pause from '@helpers/schedulers/pause';
import bytesCmp from '@helpers/bytes/bytesCmp';
import AccountController from '@lib/accounts/accountController';
import {PanelBridgeAPI, ProgressState, RestoreResult} from '../panelBridge';

const FETCH_INTERVAL = 3;

// T-9: Render a fullscreen error overlay even after pageIm has destroyed
// the auth-pages DOM (per plan F-4). Used by the rootScope 'logging_out'
// listener inside iterateRestoreSuccess once Telegram terminates the
// session post-mount. Idempotent — second call replaces the existing
// overlay.
const PANEL_ERROR_OVERLAY_ID = 'panel-progress-hard-error';
function renderHardErrorOverlay(message: string): void {
  let overlay = document.getElementById(PANEL_ERROR_OVERLAY_ID);
  if(!overlay) {
    overlay = document.createElement('div');
    overlay.id = PANEL_ERROR_OVERLAY_ID;
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:1rem',
      'padding:2rem',
      'background:var(--surface-color, #fff)',
      'color:var(--primary-text-color, #000)',
      'z-index:99999',
      'text-align:center'
    ].join(';');
    document.body.append(overlay);
  } else {
    overlay.replaceChildren();
  }
  const h4 = document.createElement('h4');
  h4.textContent = 'Авторизация Telegram';
  const p = document.createElement('p');
  p.textContent = message;
  overlay.append(h4, p);
}

const onFirstMount = async() => {
  const pageElement = page.pageEl;
  const imageDiv = pageElement.querySelector('.auth-image') as HTMLDivElement;
  imageDiv.innerHTML = '';

  const container = imageDiv.parentElement!;

  const h4 = document.createElement('h4');
  h4.textContent = 'Авторизация Telegram';

  const trackEl = document.createElement('div');
  trackEl.classList.add('panel-progress-track');
  const fillEl = document.createElement('div');
  fillEl.classList.add('panel-progress-fill');
  trackEl.append(fillEl);

  const detailEl = document.createElement('p');
  detailEl.classList.add('panel-progress-detail');

  const errorEl = document.createElement('p');
  errorEl.classList.add('panel-progress-error');
  errorEl.style.display = 'none';

  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Повторить';
  retryBtn.classList.add('btn-primary', 'panel-progress-retry');
  retryBtn.style.display = 'none';
  retryBtn.addEventListener('click', () => {
    window.location.reload();
  });

  container.append(h4, trackEl, detailEl, errorEl, retryBtn);

  const bridge = (window as any).__panelBridge;
  if(!bridge) {
    console.error('[pageProgress] No __panelBridge — page mounted in wrong context');
    return async() => {};
  }

  const render = (state: ProgressState) => {
    const pct = state.stage * 25;
    fillEl.style.width = `${pct}%`;
    if(state.error) {
      fillEl.classList.add('error');
      detailEl.style.display = 'none';
      errorEl.textContent = `Не удалось авторизоваться: ${state.error}`;
      errorEl.style.display = '';
      retryBtn.style.display = state.errorRecoverable === false ? 'none' : '';
    } else {
      fillEl.classList.remove('error');
      detailEl.style.display = '';
      detailEl.textContent = state.detail;
      errorEl.style.display = 'none';
      retryBtn.style.display = 'none';
    }
  };
  bridge.onStateChange(render);

  // ⚠️ `stop` and `pageImMounted` MUST be declared BEFORE bridge.onStateChange
  // registers the stage-4 listener. onStateChange invokes the callback
  // synchronously with the current state at registration time. If the bridge
  // is already at stage 4 (T-12 main-thread listener may fire onSessionSaved
  // before pageProgress mounts in the cached-restoration path), the if-branch
  // runs immediately and references `stop` — TDZ ReferenceError if it's
  // declared below.
  let stop = false;
  let pageImMounted = false;

  // Stage 4 → pageIm transition (subscribed once-only).
  bridge.onStateChange(async(state: ProgressState) => {
    if(state.stage === 4 && !state.error && !pageImMounted) {
      pageImMounted = true;
      stop = true;
      cachedPromise = null;
      await pause(300);
      const m = await import('./pageIm');
      m.default.mount();
    }
  });

  rootScope.addEventListener('user_auth', () => {
    stop = true;
    cachedPromise = null;
  }, {once: true});

  const options: {dcId?: DcId, ignoreErrors: true} = {ignoreErrors: true};
  let prevToken: Uint8Array | number[];

  const iterate = async(isLoop: boolean): Promise<boolean> => {
    try {
      bridge.setStage(1, 'Подключаемся к Telegram...');
      const userIds = await AccountController.getUserIds();
      let loginToken = await rootScope.managers.apiManager.invokeApi('auth.exportLoginToken', {
        api_id: App.id,
        api_hash: App.hash,
        except_ids: userIds.map((userId) => userId.toUserId())
      }, {ignoreErrors: true});

      if(loginToken._ === 'auth.loginTokenMigrateTo') {
        if(!options.dcId) {
          options.dcId = loginToken.dc_id as DcId;
          rootScope.managers.apiManager.setBaseDcId(loginToken.dc_id);
        }
        loginToken = await rootScope.managers.apiManager.invokeApi('auth.importLoginToken', {
          token: loginToken.token
        }, options) as AuthLoginToken.authLoginToken;
      }

      if(loginToken._ === 'auth.loginTokenSuccess') {
        const authorization = loginToken.authorization as any as AuthAuthorization.authAuthorization;
        const authAny = authorization as any;
        const needsPassword = !!(authAny.password_pending || authAny.passwordPending);
        if(needsPassword) {
          stop = true;
          cachedPromise = null;
          bridge.setStage(2, 'Telegram запросил пароль 2FA...');
          const m = await import('./pagePassword');
          m.default.mount();
          return true;
        }
        bridge.setStage(3, 'Загружаем чаты...');
        await rootScope.managers.apiManager.setUser(authorization.user);
        // pageIm mount is handled by the stage-4 onStateChange listener after
        // bridge.onSessionSaved fires (tweb's existing session-persistence path).
        // Fallback: if onSessionSaved doesn't run within 5s, mount pageIm anyway.
        setTimeout(() => {
          if(!pageImMounted) {
            pageImMounted = true;
            stop = true;
            cachedPromise = null;
            import('./pageIm').then((m) => m.default.mount());
          }
        }, 5000);
        return true;
      }

      // Fresh QR token — feed to Panel bridge (which sets stage 2 and POSTs /accept).
      if(!prevToken || !bytesCmp(prevToken, loginToken.token)) {
        prevToken = loginToken.token;
        try {
          await bridge.onQrToken(loginToken.token);
        } catch(e) {
          console.error('[pageProgress] onQrToken failed:', e);
          bridge.setError((e as Error).message || 'Panel API error');
          return true; // stop the loop on Panel error
        }
      }

      if(isLoop) {
        const timestamp = Date.now() / 1000;
        const diff = loginToken.expires - timestamp - await rootScope.managers.timeManager.getServerTimeOffset();
        await pause(diff > FETCH_INTERVAL ? 1e3 * FETCH_INTERVAL : 1e3 * diff | 0);
      }
    } catch(err) {
      switch((err as ApiError).type) {
        case 'SESSION_PASSWORD_NEEDED':
          bridge.setStage(2, 'Telegram запросил пароль 2FA...');
          import('./pagePassword').then((m) => m.default.mount());
          stop = true;
          cachedPromise = null;
          break;
        case 'AUTH_TOKEN_EXPIRED':
          console.warn('pageProgress: AUTH_TOKEN_EXPIRED');
          return false;
        default:
          console.error('pageProgress: default error:', err);
          bridge.setError((err as ApiError).type || 'Произошла ошибка авторизации');
          stop = true;
          break;
      }
      return true;
    }

    return false;
  };

  let first = true;

  return async() => {
    if(first) {
      first = false;
    }
    stop = false;

    // Plan F-5 / T-9 Strategy B2 — short-circuit the QR loop when the
    // bridge says we have a cached server-side session. initPanelBridge
    // already kicked off restoreCachedSession in the background; we await
    // the resulting promise via iterateRestore. On success the seeded
    // auth_key is in both localStorage and the LocalStorageController
    // in-memory cache, so getNetworker (apiManager.ts:455-457) finds it
    // on the first MTProto call. iterateRestore handles all error
    // variants (network/no_cache/unauthorized) plus the rootScope
    // 'logging_out' listener and the 5s watchdog (per plan F-2/F-4).
    const typedBridge = bridge as PanelBridgeAPI;
    if(typedBridge.cached) {
      return iterateRestore(typedBridge);
    }

    do {
      if(stop) break;
      const needBreak = await iterate(true);
      if(needBreak) break;
    } while(true);
  };
};

async function iterateRestore(bridge: PanelBridgeAPI): Promise<void> {
  bridge.setStage(2, 'Восстанавливаем сессию...');

  let result: RestoreResult;
  try {
    const restorePromise = (window as any).__panelRestorePromise as Promise<RestoreResult> | undefined;
    if(!restorePromise) {
      // Defensive — should never happen since this is called only when bridge.cached
      result = await bridge.restoreCachedSession();
    } else {
      result = await restorePromise;
    }
  } catch(e) {
    console.warn('[pageProgress] restorePromise threw:', e);
    bridge.setError('Не удалось подключиться к Panel. Попробуйте снова.');
    return;
  }

  if(result.success === true) {
    return iterateRestoreSuccess(bridge);
  }

  // result is narrowed to {success: false, code: ...} via === true above.
  if(result.code === 'network') {
    bridge.setError('Не удалось подключиться к Panel. Попробуйте снова.');
    // recoverable=true (default) — pageProgress shows retry button
    return;
  }

  // 'no_cache' or 'unauthorized' — hard error, no retry.
  if(result.code === 'unauthorized') {
    // Defensive: JWT was good but ACL/server issue. Tell backend to revoke
    // so next /start returns cached=false. (For 'no_cache' the row is
    // already gone, so markCacheDead would 401 — skip it.)
    void bridge.markCacheDead();
  }
  bridge.setError(
    'Сессия аккаунта недействительна. Закройте окно и откройте заново.',
    {recoverable: false}
  );
}

async function iterateRestoreSuccess(bridge: PanelBridgeAPI): Promise<void> {
  bridge.setStage(3, 'Загружаем чаты...');

  // Hook auth-key-dead detection (per plan F-2). Telegram terminates the
  // session — apiManager fires 'logging_out' AFTER the logout cascade
  // completes (1-2s after the original 401). By that time pageIm has
  // already mounted; we tear it down and show the hard-error UI in a
  // fullscreen overlay (per F-4 — pageProgress's DOM is gone by then).
  let cacheDeadHandled = false;
  const onLoggingOut = () => {
    if(cacheDeadHandled) return;
    cacheDeadHandled = true;
    void bridge.markCacheDead();
    bridge.setError(
      'Сессия аккаунта недействительна. Закройте окно и откройте заново.',
      {recoverable: false}
    );
    // pageIm has destroyed pageProgress DOM (per F-4). Render the error
    // UI as a top-level overlay so the operator sees the message.
    renderHardErrorOverlay('Сессия аккаунта недействительна. Закройте окно и откройте заново.');
  };
  rootScope.addEventListener('logging_out', onLoggingOut);

  // Watchdog: if pageIm doesn't respond within 5s and 'logging_out' hasn't
  // fired, assume something stalled. Show network-error variant
  // (recoverable so operator can retry).
  const watchdog = window.setTimeout(() => {
    if(cacheDeadHandled) return;
    bridge.setError('Не удалось загрузить чаты. Попробуйте снова.');
  }, 5000);

  // Brief pause so stage-3 transition is visible before pageIm wipes the DOM.
  await pause(300);

  // Mount pageIm via stage 4. This destroys pageProgress's DOM (per F-4).
  // The existing stage-4 onStateChange listener (Feature 1) imports and
  // mounts pageIm. We clear the watchdog right after — pageIm.mount is
  // async and the listener handles it independently; clearing the timer
  // here just acknowledges that stage-4 has been signaled.
  bridge.setStage(4, 'Готово');
  window.clearTimeout(watchdog);
}

let cachedPromise: Promise<() => Promise<void>> | null;
const page = new Page('page-signQR', true, () => {
  return cachedPromise;
}, () => {
  if(!cachedPromise) cachedPromise = onFirstMount();
  cachedPromise.then((func) => {
    func();
  });
});

export default page;
