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
  // Reset location.search by replacing the property each test.
  Object.defineProperty(window, 'location', {
    value: new URL('https://example.com/'),
    writable: true,
    configurable: true
  });
});

// Helper — set location.search to the given query string. Panel mode is
// detected via `?account_id=...` and the relay URL is read from `?relay_url=...`.
function setSearch(search: string) {
  const url = new URL('https://example.com/' + (search.startsWith('?') ? search : '?' + search));
  Object.defineProperty(window, 'location', {
    value: url,
    writable: true,
    configurable: true
  });
}

describe('constructTelegramWebSocketUrl', () => {
  // ── Case 1: no panel mode (no account_id in URL) → vanilla Telegram URL ─
  it('returns Telegram wss URL when location.search has no account_id (standalone tweb)', () => {
    setSearch('');
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBeDefined();
    expect(url).toMatch(/^wss:\/\/.*web\.telegram\.org\//);
    expect(url).toContain('ws2');
  });

  // ── Case 2: panel mode + relay_url → relay URL with dcId replaced ────────
  it('returns relay URL with dcId substituted in panel mode', () => {
    const relayUrl = 'wss://panel.example.com/api/ws-relay/acc-uuid/<dc>?jwt=tok123';
    setSearch(`account_id=acc-uuid&relay_url=${encodeURIComponent(relayUrl)}`);
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBe('wss://panel.example.com/api/ws-relay/acc-uuid/2?jwt=tok123');
  });

  // ── Case 3: panel mode + relay_url → different dcIds ─────────────────────
  it('substitutes the correct dcId into the relay URL', () => {
    const relayUrl = 'wss://relay.host/ws/<dc>?jwt=abc';
    setSearch(`account_id=x&relay_url=${encodeURIComponent(relayUrl)}`);
    expect(constructTelegramWebSocketUrl(5, 'client')).toBe('wss://relay.host/ws/5?jwt=abc');
    // connectionType and premium do not affect relay routing
    expect(constructTelegramWebSocketUrl(1, 'download')).toBe('wss://relay.host/ws/1?jwt=abc');
  });

  // ── Case 4: panel mode but no relay_url → hard-fail (no direct fallback) ─
  it('returns undefined (hard-fail) in panel mode when relay_url is missing', () => {
    setSearch('account_id=acc-uuid');
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBeUndefined();
  });

  // ── Case 5: panel mode + empty relay_url → hard-fail ─────────────────────
  it('returns undefined when relay_url is present but empty', () => {
    setSearch('account_id=acc-uuid&relay_url=');
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toBeUndefined();
  });

  // ── Case 6: no account_id but with relay_url present → standalone path ───
  // (Edge case — relay_url without account_id is ill-formed; we treat as
  // standalone tweb mode since panel-mode signal is account_id presence.)
  it('returns Telegram URL when relay_url is present but account_id is not', () => {
    setSearch('relay_url=wss%3A%2F%2Fshould-not-be-used%2F%3Cdc%3E');
    const url = constructTelegramWebSocketUrl(2, 'client');
    expect(url).toMatch(/web\.telegram\.org/);
  });
});
