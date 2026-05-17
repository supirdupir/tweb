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

import App from '@config/app';
import Modes from '@config/modes';
import {getEnvironment} from '@environment/utils';
import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import {IS_WEB_WORKER} from '@helpers/context';
import HTTP from '@lib/mtproto/transports/http';
import SocketProxied from '@lib/mtproto/transports/socketProxied';
import TcpObfuscated from '@lib/mtproto/transports/tcpObfuscated';
import type MTTransport from '@lib/mtproto/transports/transport';
import type {MTConnectionConstructable} from '@lib/mtproto/transports/transport';
import Socket from '@lib/mtproto/transports/websocket';
import type {DcId} from '@types';

export type TransportType = 'websocket' | 'https' | 'http';
export type ConnectionType = 'client' | 'download' | 'upload';
type Servers = {
  [transportType in TransportType]: {
    [connectionType in ConnectionType]: {
      [dcId: DcId]: MTTransport[];
    };
  };
};

const TEST_SUFFIX = Modes.test ? '_test' : '';
const PREMIUM_SUFFIX = '_premium';
const RETRY_TIMEOUT_CLIENT = 3000;
const RETRY_TIMEOUT_DOWNLOAD = 3000;

export function getTelegramConnectionSuffix(connectionType: ConnectionType) {
  return connectionType === 'client' ? '' : '-1';
}

// Panel WS-relay URL — works in BOTH main-thread (window) and worker
// (self) contexts. Bridge in main thread is unreachable from MTProto
// worker, so we don't rely on it; instead we read the relay URL from
// the document/worker location's query string. Panel-API embeds it in
// the iframe URL on /v1/login/web/lock so it's available everywhere
// the iframe code runs (main + worker + service-worker).
function getRelayUrlFromLocation(): string | undefined {
  try {
    const loc = typeof globalThis !== 'undefined' ? (globalThis as any).location : undefined;
    const search: string | undefined = loc?.search;
    if(!search) return undefined;
    const params = new URLSearchParams(search);
    const raw = params.get('relay_url');
    return raw || undefined;
  } catch{
    return undefined;
  }
}

// True when the current document/worker is running inside a Panel iframe.
// Panel always sets ?account_id=... on the iframe src (see web_login.py),
// so its presence is the panel-mode signal. When true, we MUST route
// through the relay or hard-fail (no direct-Telegram fallback) to prevent
// leaking the operator's real IP.
function isPanelMode(): boolean {
  try {
    const loc = typeof globalThis !== 'undefined' ? (globalThis as any).location : undefined;
    const search: string | undefined = loc?.search;
    if(!search) return false;
    return new URLSearchParams(search).has('account_id');
  } catch{
    return false;
  }
}

export function constructTelegramWebSocketUrl(
  dcId: DcId,
  connectionType: ConnectionType,
  premium?: boolean,
) {
  if(!import.meta.env.VITE_MTPROTO_HAS_WS) {
    return;
  }

  // Panel WS-relay override — applies in BOTH main-thread iframe and
  // MTProto worker (which has no window.__panelBridge access). Read
  // relay URL from query string written by /v1/login/web/lock.
  if(isPanelMode()) {
    const relayUrl = getRelayUrlFromLocation();
    if(!relayUrl) {
      // Panel mode but no relay URL — hard-fail, no direct-Telegram fallback.
      // This prevents the IP leak that occurred when the worker context
      // silently fell through to wss://venus*.web.telegram.org.

      console.error('[dcConfigurator] panel mode but no relay_url in location.search — refusing direct connection');
      return undefined;
    }
    // Replace the DC placeholder. Relay URL format from the server:
    //   wss://host/api/ws-relay/<account_id>/<dc>?jwt=<token>
    return relayUrl.replace('<dc>', String(dcId));
  }

  // Standalone tweb (no panel) — direct Telegram URL.
  const suffix = getTelegramConnectionSuffix(connectionType);
  const path =
    connectionType !== 'client' ?
      'apiws' + TEST_SUFFIX + (premium ? PREMIUM_SUFFIX : '') :
      'apiws' + TEST_SUFFIX;
  const chosenServer = `wss://${App.suffix.toLowerCase()}ws${dcId}${suffix}.web.telegram.org/${path}`;

  return chosenServer;
}

export class DcConfigurator {
  private sslSubdomains = ['pluto', 'venus', 'aurora', 'vesta', 'flora'];

  private dcOptions = Modes.test ?
    [
      {id: 1, host: '149.154.175.10', port: 80},
      {id: 2, host: '149.154.167.40', port: 80},
      {id: 3, host: '149.154.175.117', port: 80}
    ] :
    [
      {id: 1, host: '149.154.175.50', port: 80},
      {id: 2, host: '149.154.167.50', port: 80},
      {id: 3, host: '149.154.175.100', port: 80},
      {id: 4, host: '149.154.167.91', port: 80},
      {id: 5, host: '149.154.171.5', port: 80}
    ];

  public chosenServers: Servers = {} as any;

  private transportSocket = (dcId: DcId, connectionType: ConnectionType, premium?: boolean) => {
    if(!import.meta.env.VITE_MTPROTO_HAS_WS) {
      return;
    }

    const chosenServer = constructTelegramWebSocketUrl(dcId, connectionType, premium);
    const logSuffix =
      connectionType === 'upload' ? '-U' : connectionType === 'download' ? '-D' : '';

    const retryTimeout =
      connectionType === 'client' ? RETRY_TIMEOUT_CLIENT : RETRY_TIMEOUT_DOWNLOAD;

    let oooohLetMeLive: MTConnectionConstructable;
    if(import.meta.env.VITE_MTPROTO_SW || !import.meta.env.VITE_SAFARI_PROXY_WEBSOCKET) {
      oooohLetMeLive = Socket;
    } else {
      oooohLetMeLive =
        getEnvironment().IS_SAFARI &&
        IS_WEB_WORKER &&
        typeof SocketProxied !== 'undefined' ? /* || true */
          SocketProxied :
          Socket;
    }

    return new TcpObfuscated(oooohLetMeLive, dcId, chosenServer, logSuffix, retryTimeout);
  };

  private transportHTTP = (dcId: DcId, connectionType: ConnectionType, _premium?: boolean) => {
    if(!import.meta.env.VITE_MTPROTO_HAS_HTTP) {
      return;
    }

    // Panel mode — block HTTPS transport entirely, force websocket-only via
    // panel relay. Otherwise tweb's pingTransports may pick HTTPS as a
    // fallback and go direct to venus*.web.telegram.org, leaking the
    // operator's real IP. v1 relay is wss:// only.
    if(isPanelMode()) {
      return;
    }

    let chosenServer: string;
    if(Modes.ssl || !Modes.http) {
      const suffix = getTelegramConnectionSuffix(connectionType);
      const subdomain = this.sslSubdomains[dcId - 1] + suffix;
      const path = Modes.test ? 'apiw_test1' : 'apiw1';
      chosenServer = 'https://' + subdomain + '.web.telegram.org/' + path;
    } else {
      for(const dcOption of this.dcOptions) {
        if(dcOption.id === dcId) {
          chosenServer =
            'http://' +
            dcOption.host +
            (dcOption.port !== 80 ? ':' + dcOption.port : '') +
            '/apiw1';
          break;
        }
      }
    }

    const logSuffix =
      connectionType === 'upload' ? '-U' : connectionType === 'download' ? '-D' : '';
    return new HTTP(dcId, chosenServer, logSuffix);
  };

  public chooseServer(
    dcId: DcId,
    connectionType: ConnectionType = 'client',
    transportType: TransportType = Modes.transport,
    reuse = true,
    premium?: boolean,
  ) {
    /* if(transportType === 'websocket' && !Modes.multipleConnections) {
      connectionType = 'client';
    } */

    // Panel mode: silently rewrite https → websocket so that EVERY caller
    // (authorizer, pingTransports, network manager, etc.) ends up with a
    // working websocket transport routed through the relay. Without this
    // remap, callers that asked for https get null and crash on
    // ``transport.send()`` / ``transport._send()``.
    if(transportType === 'https' && isPanelMode()) {
      transportType = 'websocket';
    }

    if(!this.chosenServers.hasOwnProperty(transportType)) {
      this.chosenServers[transportType] = {
        client: {},
        download: {},
        upload: {}
      };
    }

    const servers = this.chosenServers[transportType][connectionType];

    if(!(dcId in servers)) {
      servers[dcId] = [];
    }

    const transports = servers[dcId];

    if(!transports.length || !reuse /*  || (upload && transports.length < 1) */) {
      let transport: MTTransport;

      if(import.meta.env.VITE_MTPROTO_HAS_WS && import.meta.env.VITE_MTPROTO_HAS_HTTP) {
        transport = (transportType === 'websocket' ? this.transportSocket : this.transportHTTP)(
          dcId,
          connectionType,
          premium,
        );
      } else if(!import.meta.env.VITE_MTPROTO_HTTP) {
        transport = this.transportSocket(dcId, connectionType, premium);
      } else {
        transport = this.transportHTTP(dcId, connectionType, premium);
      }

      if(!transport) {
        console.error('No chosenServer!', dcId);
        return null;
      }

      if(reuse) {
        transports.push(transport);
      }

      return transport;
    }

    return transports[0];
  }

  public static removeTransport<T>(obj: any, transport: T) {
    for(const transportType in obj) {
      // @ts-ignore
      for(const connectionType in obj[transportType]) {
        // @ts-ignore
        for(const dcId in obj[transportType][connectionType]) {
          // @ts-ignore
          const transports: T[] = obj[transportType][connectionType][dcId];
          indexOfAndSplice(transports, transport);
        }
      }
    }
  }
}
