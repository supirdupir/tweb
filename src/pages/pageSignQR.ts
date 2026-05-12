/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {DcId} from '@types';
import Page from '@/pages/page';
import {AuthAuthorization, AuthLoginToken} from '@layer';
import App from '@config/app';
import Button from '@components/button';
import {_i18n, i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {putPreloader} from '@components/putPreloader';
import getLanguageChangeButton from '@components/languageChangeButton';
import pause from '@helpers/schedulers/pause';
import fixBase64String from '@helpers/fixBase64String';
import bytesCmp from '@helpers/bytes/bytesCmp';
import bytesToBase64 from '@helpers/bytes/bytesToBase64';
import textToSvgURL from '@helpers/textToSvgURL';
import AccountController from '@lib/accounts/accountController';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import PasskeyLoginButton from '@components/passkeyLoginButton';

const FETCH_INTERVAL = 3;

const onFirstMount = async() => {
  const pageElement = page.pageEl;
  const imageDiv = pageElement.querySelector('.auth-image') as HTMLDivElement;

  let preloader = putPreloader(imageDiv, true);

  const inputWrapper = document.createElement('div');
  inputWrapper.classList.add('input-wrapper');

  const btnBack = Button('btn-primary btn-secondary btn-primary-transparent primary', {text: 'Login.QR.Cancel'});
  const passkeyButton = PasskeyLoginButton();
  inputWrapper.append(...[btnBack, passkeyButton?.button].filter(Boolean));

  if(getCurrentAccount() === 1) {
    getLanguageChangeButton(inputWrapper);
  }

  const container = imageDiv.parentElement;

  const h4 = document.createElement('h4');
  _i18n(h4, 'Login.QR.Title');

  const helpList = document.createElement('ol');
  helpList.classList.add('qr-description');
  (['Login.QR.Help1', 'Login.QR.Help2', 'Login.QR.Help3'] as LangPackKey[]).forEach((key) => {
    const li = document.createElement('li');
    li.append(i18n(key));
    helpList.append(li);
  });

  container.append(h4, helpList, inputWrapper);

  btnBack.addEventListener('click', () => {
    import('./pageSignIn').then((m) => m.default.mount());
    stop = true;
  });

  const results = await Promise.all([
    import('qr-code-styling' as any)
  ]);
  const QRCodeStyling = results[0].default;

  let stop = false;
  rootScope.addEventListener('user_auth', (auth) => {
    stop = true;
    cachedPromise = null;
  }, {once: true});

  const options: {dcId?: DcId, ignoreErrors: true} = {ignoreErrors: true};
  let prevToken: Uint8Array | number[];

  const iterate = async(isLoop: boolean) => {
    try {
      const userIds = await AccountController.getUserIds();
      let loginToken = await rootScope.managers.apiManager.invokeApi('auth.exportLoginToken', {
        api_id: App.id,
        api_hash: App.hash,
        except_ids: userIds.map((userId) => userId.toUserId())
        // except_ids: []
      }, {ignoreErrors: true});

      if(loginToken._ === 'auth.loginTokenMigrateTo') {
        if(!options.dcId) {
          options.dcId = loginToken.dc_id as DcId;
          rootScope.managers.apiManager.setBaseDcId(loginToken.dc_id);
          // continue;
        }

        loginToken = await rootScope.managers.apiManager.invokeApi('auth.importLoginToken', {
          token: loginToken.token
        }, options) as AuthLoginToken.authLoginToken;
      }

      if(loginToken._ === 'auth.loginTokenSuccess') {
        const authorization = loginToken.authorization as any as AuthAuthorization.authAuthorization;
        // Plan 06: when farm-side AcceptLoginToken returned
        // password_pending=true, the authorization here will also carry
        // a password-pending flag. The iframe must complete CheckPassword
        // before pageIm makes sense — mount pagePassword (which auto-fills
        // via PanelBridge.getTwoFAPassword) instead of pageIm.
        const authAny = authorization as any;
        const needsPassword = !!(authAny.password_pending || authAny.passwordPending);
        if(needsPassword) {
          stop = true;
          cachedPromise = null;
          const m = await import('./pagePassword');
          m.default.mount();
          return true;
        }
        await rootScope.managers.apiManager.setUser(authorization.user);
        import('./pageIm').then((m) => m.default.mount());
        return true;
      }

      /* // to base64
      var decoder = new TextDecoder('utf8');
      var b64encoded = btoa(String.fromCharCode.apply(null, [...loginToken.token])); */

      if(!prevToken || !bytesCmp(prevToken, loginToken.token)) {
        prevToken = loginToken.token;

        // Plan 06 T16: hand fresh QR token to Panel so it can call auth.AcceptLoginToken
        // via the existing-account farm session. Bridge is undefined when running
        // outside Panel's iframe wrapper — fall through to normal QR display in
        // that case (e.g. running tweb standalone). 2FA path: when Panel returns
        // password_pending=true, we let the iframe's own exportLoginToken poll
        // complete and dispatch loginTokenSuccess (which carries the same
        // password_pending bit on the authorization object) — the success
        // branch above mounts pagePassword from there. Mounting pagePassword
        // here, before the iframe gets the new auth_key from loginTokenSuccess,
        // hits AUTH_KEY_UNREGISTERED on account.GetPassword.
        const bridge = (window as any).__panelBridge;
        if(bridge) {
          try {
            await bridge.onQrToken(loginToken.token);
          } catch(e) {
            console.error('[panelBridge] onQrToken failed:', e);
            // Fall through to QR display so user can scan with phone if Panel
            // bridge is broken (e.g. JWT expired, Panel API down).
          }
        }

        const encoded = bytesToBase64(loginToken.token);
        const url = 'tg://login?token=' + fixBase64String(encoded, true);

        const style = window.getComputedStyle(document.documentElement);
        const surfaceColor = style.getPropertyValue('--surface-color').trim();
        const textColor = style.getPropertyValue('--primary-text-color').trim();
        const primaryColor = style.getPropertyValue('--primary-color').trim();

        const logoUrl = await fetch('assets/img/logo_padded.svg')
        .then((res) => res.text())
        .then((text) => {
          text = text.replace(/(fill:).+?(;)/, `$1${primaryColor}$2`);
          return textToSvgURL(text);
        });

        const qrCode = new QRCodeStyling({
          width: 240 * window.devicePixelRatio,
          height: 240 * window.devicePixelRatio,
          data: url,
          image: logoUrl,
          dotsOptions: {
            color: textColor,
            type: 'rounded'
          },
          cornersSquareOptions: {
            type: 'extra-rounded'
          },
          imageOptions: {
            imageSize: 1,
            margin: 0
          },
          backgroundOptions: {
            color: surfaceColor
          },
          qrOptions: {
            errorCorrectionLevel: 'L'
          }
        });

        qrCode.append(imageDiv);
        (imageDiv.lastChild as HTMLCanvasElement).classList.add('qr-canvas');

        let promise: Promise<void>;
        if(qrCode._drawingPromise) {
          promise = qrCode._drawingPromise;
        } else {
          promise = Promise.race([
            pause(1000),
            new Promise<void>((resolve) => {
              qrCode._canvas._image.addEventListener('load', () => {
                window.requestAnimationFrame(() => resolve());
              }, {once: true});
            })
          ]);
        }

        // * это костыль, но библиотека не предоставляет никаких событий
        await promise.then(() => {
          if(preloader) {
            preloader.style.animation = 'hide-icon .4s forwards';

            const c = imageDiv.children[1] as HTMLElement;
            c.style.display = 'none';
            c.style.animation = 'grow-icon .4s forwards';
            setTimeout(() => {
              c.style.display = '';
            }, 150);

            setTimeout(() => {
              c.style.animation = '';
            }, 500);
            preloader = undefined;
          } else {
            Array.from(imageDiv.children).slice(0, -1).forEach((el) => {
              el.remove();
            });
          }
        });
      }

      if(isLoop) {
        const timestamp = Date.now() / 1000;
        const diff = loginToken.expires - timestamp - await rootScope.managers.timeManager.getServerTimeOffset();

        await pause(diff > FETCH_INTERVAL ? 1e3 * FETCH_INTERVAL : 1e3 * diff | 0);
      }
    } catch(err) {
      switch((err as ApiError).type) {
        case 'SESSION_PASSWORD_NEEDED':
          import('./pagePassword').then((m) => m.default.mount());
          stop = true;
          cachedPromise = null;
          break;
        case 'AUTH_TOKEN_EXPIRED':
          console.warn('pageSignQR: AUTH_TOKEN_EXPIRED');
          return false;
        default:
          console.error('pageSignQR: default error:', err);
          stop = true;
          break;
      }

      return true;
    }

    return false;
  };

  // await iterate(false);

  let first = true;

  return async() => {
    if(first) {
      first = false;
      passkeyButton && passkeyButton.fetch();
    }

    stop = false;

    do {
      if(stop) {
        break;
      }

      const needBreak = await iterate(true);
      if(needBreak) {
        break;
      }
    } while(true);
  };
};

let cachedPromise: Promise<() => Promise<void>>;
const page = new Page('page-signQR', true, () => {
  return cachedPromise;
}, () => {
  // console.log('onMount');
  if(!cachedPromise) cachedPromise = onFirstMount();
  cachedPromise.then((func) => {
    func();
  });

  rootScope.managers.appStateManager.pushToState('authState', {_: 'authStateSignQr'});
});

export default page;
