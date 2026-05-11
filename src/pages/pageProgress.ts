/*
 * pageProgress — Panel-mode replacement for pageSignQR.
 *
 * Two flows muxed off `bridge.cached`:
 *   cached=1 → iterateRestore: await the GET /v1/login/web/cache promise the
 *              bridge started during initPanelBridge; on success stage=4 and
 *              mount pageIm.
 *   cached=0 → iterateQR: same auth.exportLoginToken poll loop as upstream
 *              pageSignQR, but every new token is forwarded to
 *              bridge.onQrToken(token) which proxies auth.AcceptLoginToken
 *              through the farm. Telegram still returns loginTokenSuccess to
 *              this iframe through normal channels — our bridge call is
 *              additive, not a replacement.
 *
 * The hard-error overlay (renderHardErrorOverlay) is needed because
 * Page.installPromise is memoized — once pageIm has mounted, calling
 * pageProgress.mount() again won't re-run onFirstMount. The overlay is a
 * fullscreen `position:fixed` div appended to document.body, independent of
 * Page lifecycle. See panel-side .claude/rules/tweb.md § 5.
 */

import type {DcId} from '@types';
import Page from '@/pages/page';
import {AuthAuthorization, AuthLoginToken} from '@layer';
import App from '@config/app';
import rootScope from '@lib/rootScope';
import pause from '@helpers/schedulers/pause';
import bytesCmp from '@helpers/bytes/bytesCmp';
import AccountController from '@lib/accounts/accountController';
import type {PanelBridge, ProgressState, RestoreResult} from '@/panelBridge';

const FETCH_INTERVAL = 3;

interface ProgressDom {
  titleEl: HTMLHeadingElement;
  trackEl: HTMLDivElement;
  fillEl: HTMLDivElement;
  detailEl: HTMLDivElement;
  errorEl: HTMLDivElement;
  retryBtn: HTMLButtonElement;
}

function buildDom(pageElement: HTMLElement): ProgressDom {
  pageElement.replaceChildren();
  const container = document.createElement('div');
  container.classList.add('container', 'center-align', 'panel-progress-container');

  const titleEl = document.createElement('h4');
  titleEl.classList.add('panel-progress-title');
  titleEl.textContent = 'Авторизация Telegram';

  const trackEl = document.createElement('div');
  trackEl.classList.add('panel-progress-track');

  const fillEl = document.createElement('div');
  fillEl.classList.add('panel-progress-fill');
  trackEl.appendChild(fillEl);

  const detailEl = document.createElement('div');
  detailEl.classList.add('panel-progress-detail');

  const errorEl = document.createElement('div');
  errorEl.classList.add('panel-progress-error');
  errorEl.style.display = 'none';

  const retryBtn = document.createElement('button');
  retryBtn.classList.add('btn-primary', 'btn-color-primary', 'panel-progress-retry');
  retryBtn.textContent = 'Перезагрузить';
  retryBtn.style.display = 'none';
  retryBtn.addEventListener('click', () => {
    window.location.reload();
  });

  container.append(titleEl, trackEl, detailEl, errorEl, retryBtn);
  pageElement.appendChild(container);

  return {titleEl, trackEl, fillEl, detailEl, errorEl, retryBtn};
}

function applyState(dom: ProgressDom, state: ProgressState): void {
  const widthPct = state.stage * 25;
  dom.fillEl.style.width = widthPct + '%';

  dom.detailEl.textContent = state.detail;

  if(state.error) {
    dom.fillEl.classList.add('error');
    dom.detailEl.style.display = 'none';
    dom.errorEl.textContent = state.error;
    dom.errorEl.style.display = '';
    dom.retryBtn.style.display = state.errorRecoverable ? '' : 'none';
  } else {
    dom.fillEl.classList.remove('error');
    dom.detailEl.style.display = '';
    dom.errorEl.style.display = 'none';
    dom.retryBtn.style.display = 'none';
  }
}

function renderHardErrorOverlay(msg: string): void {
  const existing = document.querySelector('.panel-progress-hard-error-overlay');
  if(existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'panel-progress-hard-error-overlay';

  const card = document.createElement('div');
  card.className = 'panel-progress-hard-error-card';

  const title = document.createElement('h4');
  title.textContent = 'Сессия отозвана';
  const body = document.createElement('p');
  body.textContent = msg;

  card.append(title, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

async function iterateRestore(
  bridge: PanelBridge,
  dom: ProgressDom,
  mountPageIm: () => Promise<void>
): Promise<void> {
  // Bridge started restoreCachedSession in initPanelBridge and stashed the
  // promise on window. If it's missing (e.g. cached=0 was lied about by the
  // URL), re-run restore from scratch.
  const stashed = (window as any).__panelRestorePromise as Promise<RestoreResult> | undefined;
  const result = await (stashed || bridge.restoreCachedSession());

  if(result.success) {
    bridge.setStage(4, 'Готово');
    // Small pause lets the parent see stage=4 postMessage and hide the
    // ProgressBar overlay before pageIm starts painting heavy DOM.
    await pause(300);
    await mountPageIm();
    return;
  }

  // Failure: bridge.setError was already called inside restoreCachedSession,
  // so the DOM is already showing the error via the onStateChange listener.
  // On unauthorized: we also POST /cache/revoke so the next /start returns
  // cached=false and the operator sees a fresh QR flow.
  if(result.code === 'unauthorized') {
    void bridge.markCacheDead();
  }
}

async function iterateQR(
  bridge: PanelBridge,
  dom: ProgressDom,
  mountPageIm: () => Promise<void>
): Promise<void> {
  let stop = false;
  let prevToken: Uint8Array | number[] | undefined;

  rootScope.addEventListener('user_auth', () => {
    stop = true;
  }, {once: true});

  const options: {dcId?: DcId; ignoreErrors: true} = {ignoreErrors: true};

  bridge.setStage(1, 'Подключаемся к Telegram...');

  while(!stop) {
    try {
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
        await rootScope.managers.apiManager.setUser(authorization.user);
        bridge.setStage(3, 'Загружаем чаты...');
        await mountPageIm();
        return;
      }

      // Fresh token from Telegram — proxy to Panel so it can call
      // auth.AcceptLoginToken from the farm side. Dedup so a fast loop
      // doesn't hammer /accept with the same token.
      if(!prevToken || !bytesCmp(prevToken, loginToken.token)) {
        prevToken = loginToken.token;
        try {
          await bridge.onQrToken(loginToken.token);
        } catch(e) {
          // setError was already called inside onQrToken; loop continues
          // but with progress bar showing the error.
          console.warn('[pageProgress] onQrToken failed, will retry on next token:', e);
        }
      }

      const timestamp = Date.now() / 1000;
      const diff = loginToken.expires - timestamp
        - await rootScope.managers.timeManager.getServerTimeOffset();
      await pause(diff > FETCH_INTERVAL ? 1e3 * FETCH_INTERVAL : 1e3 * diff | 0);
    } catch(err) {
      switch((err as ApiError).type) {
        case 'SESSION_PASSWORD_NEEDED':
          // Telegram requires 2FA — hand off to pagePassword. PanelBridge's
          // pagePassword auto-fill hook will pull the stored password from
          // Keeper and submit it.
          import('./pagePassword').then((m) => m.default.mount());
          stop = true;
          break;
        case 'AUTH_TOKEN_EXPIRED':
          // Loop continues — next iteration grabs a fresh token.
          break;
        default:
          console.error('[pageProgress] iterate error:', err);
          bridge.setError('Ошибка авторизации: ' + ((err as ApiError).type || 'unknown'));
          stop = true;
          break;
      }
    }
  }
}

const onFirstMount = async() => {
  const bridge = (window as any).__panelBridge as PanelBridge | undefined;
  if(!bridge) {
    // index.ts only mounts pageProgress when panelMode=true, so the bridge
    // must be set. If we get here, something is misconfigured — log and
    // bail so the surrounding error UI shows.
    console.error('[pageProgress] no __panelBridge on window — boot misconfigured');
    return async() => {};
  }

  const dom = buildDom(page.pageEl);
  applyState(dom, bridge.getState());

  let pageImMounted = false;
  const mountPageIm = async() => {
    if(pageImMounted) return;
    pageImMounted = true;
    const m = await import('./pageIm');
    await m.default.mount();
  };

  // Subscribe to bridge progress events. Drive the DOM, and also auto-mount
  // pageIm when stage hits 4 (covers the cache-write-completed path where
  // setStage(4) fires from onSessionSaved without going through iterate()).
  bridge.onStateChange((state) => {
    applyState(dom, state);
    if(state.stage === 4) {
      void mountPageIm();
    }
  });

  // Once pageIm has mounted, the DOM driven by applyState is no longer
  // visible (pageIm replaced it). If MTProto then dies (AUTH_KEY_INVALID
  // etc.), tweb dispatches 'logging_out'. PanelBridge's global listener
  // already POSTs /cache/revoke + parent postMessage; we additionally show
  // a hard-error overlay so the operator knows the iframe is dead.
  rootScope.addEventListener('logging_out', () => {
    bridge.setError('Сессия аккаунта недействительна. Закройте окно и откройте заново.', {recoverable: false});
    renderHardErrorOverlay(bridge.getState().error || 'Сессия отозвана Telegram.');
  });

  return async() => {
    if(bridge.cached) {
      await iterateRestore(bridge, dom, mountPageIm);
    } else {
      await iterateQR(bridge, dom, mountPageIm);
    }
  };
};

let cachedPromise: Promise<() => Promise<void>>;
const page = new Page('page-progress', true, () => {
  return cachedPromise;
}, () => {
  if(!cachedPromise) cachedPromise = onFirstMount();
  cachedPromise.then((func) => {
    func();
  });
  // No appStateManager.pushToState here — panel mode bypasses the upstream
  // authState machine entirely. State is driven by the bridge.
});

export default page;
