import deferredPromise, {CancellablePromise} from '@helpers/cancellablePromise';
import {getPanelAccountId} from '@lib/panelAccountScope';

let worker: Worker;
let promises: CancellablePromise<TranslatableLanguageISO>[];

export default function detectLanguage(text: string): Promise<TranslatableLanguageISO> {
  if(!worker) {
    // Defense-in-depth: name the worker `panel-{accountId}` so any
    // future code path that calls getPanelAccountId() inside the worker
    // resolves correctly (panelAccountScope.ts:54-64).
    const accountId = getPanelAccountId();
    const workerName = accountId ? `panel-${accountId}` : '';
    worker = new Worker(new URL('./tinyld.worker.ts', import.meta.url), {type: 'module', name: workerName});
    worker.addEventListener('message', (e) => {
      const {lang} = e.data;
      const promise = promises.shift();
      promise.resolve(lang);
    });

    promises = [];
  }

  const deferred = deferredPromise<TranslatableLanguageISO>();
  promises.push(deferred);
  worker.postMessage({text});
  return deferred;
}
