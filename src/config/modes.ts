/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 *
 * Originally from:
 * https://github.com/zhukov/webogram
 * Copyright (C) 2014 Igor Zhukov <igor.beatle@gmail.com>
 * https://github.com/zhukov/webogram/blob/master/LICENSE
 */

import type { TransportType } from "@lib/mtproto/dcConfigurator";

const Modes = {
  test: location.search.indexOf("test=1") > 0 /*  || true */,
  debug: location.search.indexOf("debug=1") > 0,
  http: false,
  ssl: true, // location.search.indexOf('ssl=1') > 0 || location.protocol === 'https:' && location.search.indexOf('ssl=0') === -1,
  asServiceWorker: !!import.meta.env.VITE_MTPROTO_SW,
  transport: "websocket" as TransportType,
  noSharedWorker: location.search.indexOf("noSharedWorker=1") > 0,
  noServiceWorker: location.search.indexOf("noServiceWorker=1") > 0,
  multipleTransports:
    !!(
      import.meta.env.VITE_MTPROTO_AUTO &&
      import.meta.env.VITE_MTPROTO_HAS_HTTP &&
      import.meta.env.VITE_MTPROTO_HAS_WS
    ) && location.search.indexOf("noMultipleTransports=1") === -1,
  noPfs: true || location.search.indexOf("noPfs=1") > 0,
};

if (import.meta.env.VITE_MTPROTO_HAS_HTTP) {
  const httpOnly = (Modes.http = location.search.indexOf("http=1") > 0);
  if (httpOnly) {
    Modes.multipleTransports = false;
  }
}

// * start with HTTP first
if (Modes.multipleTransports) {
  Modes.http = true;
}

if (Modes.http) {
  Modes.transport = "https";
}

// Panel mode (iframe URL has ?account_id=...) — force websocket transport.
// In panel mode HTTPS transport is unconditionally blocked by dcConfigurator
// (transportHTTP returns undefined, so chooseServer returns null). Starting
// with "https" would crash on transport.destroy() at apiManager.ts:568
// during the auth-transport-recheck path. Tweb's standalone "start with HTTP
// first" optimisation has zero value when HTTPS is disabled anyway.
if (location.search.indexOf("account_id=") > 0) {
  Modes.transport = "websocket";
  Modes.http = false;
  Modes.multipleTransports = false;
}

export default Modes;
