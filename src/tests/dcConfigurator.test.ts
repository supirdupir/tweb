import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {constructTelegramWebSocketUrl} from '../lib/mtproto/dcConfigurator';

// constructTelegramWebSocketUrl is gated on VITE_MTPROTO_HAS_WS.
// Stub it to a truthy value for all tests in this suite.
beforeEach(() => {
  vi.stubEnv('VITE_MTPROTO_HAS_WS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as any).__panelBridge;
});

describe('constructTelegramWebSocketUrl', () => {
  // ── Case 1: no bridge → vanilla Telegram URL ──────────────────────────────
  it('returns Telegram wss URL when no panel bridge is present', () => {
    delete (window as any).__panelBridge;
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBeDefined();
    expect(url).toMatch(/^wss:\/\/.*web\.telegram\.org\//);
    expect(url).toContain('ws2');
  });

  // ── Case 2: bridge + config → relay URL with dcId replaced ───────────────
  it('returns relay URL with dcId substituted when bridge config is set', () => {
    const relayUrl = 'wss://panel.example.com/api/ws-relay/acc-uuid/<dc>?jwt=tok123';
    (window as any).__panelBridge = {
      capabilities: {proxyRelay: true},
      getProxyConfig: () => ({relayUrl})
    };
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBe('wss://panel.example.com/api/ws-relay/acc-uuid/2?jwt=tok123');
  });

  // ── Case 3: bridge + config → different dcId ─────────────────────────────
  it('substitutes the correct dcId into the relay URL', () => {
    const relayUrl = 'wss://relay.host/ws/<dc>?jwt=abc';
    (window as any).__panelBridge = {
      capabilities: {proxyRelay: true},
      getProxyConfig: () => ({relayUrl})
    };
    expect(constructTelegramWebSocketUrl(5, 'client')).toBe('wss://relay.host/ws/5?jwt=abc');
    // connectionType and premium do not affect relay routing
    expect(constructTelegramWebSocketUrl(1, 'download')).toBe('wss://relay.host/ws/1?jwt=abc');
  });

  // ── Case 4: bridge present but config not yet received → hard-fail ────────
  it('returns undefined (hard-fail) when bridge is present but config is null', () => {
    (window as any).__panelBridge = {
      capabilities: {proxyRelay: true},
      getProxyConfig: (): null => null
    };
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBeUndefined();
  });

  // ── Case 5: bridge present but capabilities.proxyRelay false → vanilla ────
  it('returns Telegram URL when bridge.capabilities.proxyRelay is false', () => {
    (window as any).__panelBridge = {
      capabilities: {proxyRelay: false},
      getProxyConfig: () => ({relayUrl: 'wss://should-not-be-used/<dc>'})
    };
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toMatch(/web\.telegram\.org/);
  });

  // ── Case 6: bridge present but no capabilities field → vanilla ────────────
  it('returns Telegram URL when bridge has no capabilities field', () => {
    (window as any).__panelBridge = {
      getProxyConfig: () => ({relayUrl: 'wss://should-not-be-used/<dc>'})
    };
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toMatch(/web\.telegram\.org/);
  });
});
