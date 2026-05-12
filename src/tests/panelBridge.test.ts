import {initPanelBridge, PanelBridgeError, _resetPanelBridgeForTesting} from '../panelBridge';

// Helper — set window.location.search before each test.
function setSearch(search: string) {
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: {...window.location, search}
  });
}

describe('PanelBridge', () => {
  beforeEach(() => {
    _resetPanelBridgeForTesting();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('returns false when URL has no jwt param', async() => {
    setSearch('');
    const result = initPanelBridge();
    expect(result.panelMode).toBe(false);
    expect(result.restorePromise).toBeNull();
    expect((window as any).__panelBridge).toBeUndefined();
  });

  test('returns true with valid params and sets __panelBridge', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    // cached=1 triggers restoreCachedSession in background — stub fetch
    // so the kicked-off promise doesn't make real HTTP calls.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503
    } as Response));
    setSearch(`?jwt=tok123&account_id=${uuid}&cached=1`);
    const result = initPanelBridge();
    expect(result.panelMode).toBe(true);
    const bridge = (window as any).__panelBridge;
    expect(bridge).toBeDefined();
    expect(bridge.accountId).toBe(uuid);
    expect(bridge.cached).toBe(true);
  });

  test('cached=0 sets cached to false', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440001';
    setSearch(`?jwt=tok456&account_id=${uuid}&cached=0`);
    initPanelBridge();
    expect((window as any).__panelBridge.cached).toBe(false);
  });

  test('onQrToken POSTs to /v1/login/web/accept, sends base64 token, rotates JWT', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440002';
    const nextJwt = 'jwt_for_cache_xyz';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({jwt_for_cache: nextJwt})
    });
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=initial_jwt&account_id=${uuid}&cached=0`);
    initPanelBridge();

    const bridge = (window as any).__panelBridge;
    const token = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const result = await bridge.onQrToken(token);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/login/web/accept');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.jwt).toBe('initial_jwt');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    // 0xDE 0xAD 0xBE 0xEF → base64 "3q2+7w=="
    expect(body.token).toBe('3q2+7w==');
    expect((bridge as any).currentJwt).toBe(nextJwt);
    // Default response (no password_pending field) → false
    expect(result.passwordPending).toBe(false);
  });

  test('onQrToken returns passwordPending=true when API says password_pending', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aaaa';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({jwt_for_cache: 'next', password_pending: true})
    });
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=x&account_id=${uuid}&cached=0`);
    initPanelBridge();

    const bridge = (window as any).__panelBridge;
    const result = await bridge.onQrToken(new Uint8Array([0x01]));
    expect(result.passwordPending).toBe(true);
  });

  test('getTwoFAPassword GETs /v1/.../2fa-password, returns password, rotates JWT', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440003';
    const nextJwt = 'jwt_after_2fa';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({password: 'hunter2', jwt_for_next: nextJwt})
    });
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=before_2fa_jwt&account_id=${uuid}&cached=0`);
    initPanelBridge();

    const bridge = (window as any).__panelBridge;
    const password = await bridge.getTwoFAPassword();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(`/v1/accounts/${uuid}/login/web/2fa-password`);
    expect(url).toContain('jwt=before_2fa_jwt');
    expect(password).toBe('hunter2');
    expect((bridge as any).currentJwt).toBe(nextJwt);
  });

  test('onSessionSaved POSTs base64-encoded auth_key to /v1/login/web/cache, no JWT rotation', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440004';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({})
    });
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=cache_jwt&account_id=${uuid}&cached=0`);
    initPanelBridge();

    const bridge = (window as any).__panelBridge;
    await bridge.onSessionSaved({authKeyHex: 'abcd', dcId: 2, userId: 42});

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/login/web/cache');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.jwt).toBe('cache_jwt');
    // 0xAB=171, 0xCD=205 → btoa(String.fromCharCode(171,205)) = "q80="
    expect(body.auth_key).toBe('q80=');
    expect(body.dc_id).toBe(2);
    expect(body.user_id).toBe(42);
    // Terminal — no JWT rotation
    expect((bridge as any).currentJwt).toBe('cache_jwt');
  });

  test('onQrToken throws PanelBridgeError with code unauthorized on 401', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440005';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    });
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=bad_jwt&account_id=${uuid}&cached=0`);
    initPanelBridge();

    const bridge = (window as any).__panelBridge;
    const token = new Uint8Array([0x01]);
    await expect(bridge.onQrToken(token)).rejects.toBeInstanceOf(PanelBridgeError);
    await expect(bridge.onQrToken(token)).rejects.toMatchObject({code: 'unauthorized'});
  });

  test('isIdempotent — second initPanelBridge() call returns without resetting', async() => {
    const uuid = '550e8400-e29b-41d4-a716-446655440006';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    const r1 = initPanelBridge();
    const r2 = initPanelBridge();
    expect(r1.panelMode).toBe(true);
    expect(r2.panelMode).toBe(true);
    // First call kicks off restore (only when cached=1, so null here);
    // second call always returns null restorePromise — caller stashed
    // the original on the first call.
    expect(r1.restorePromise).toBeNull();
    expect(r2.restorePromise).toBeNull();
    // Only one bridge instance — same object reference
    expect((window as any).__panelBridge).toBeDefined();
  });

  test('initial state has stage=1, default detail, no error', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa01';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    const state = bridge.getState();
    expect(state.stage).toBe(1);
    expect(state.detail).toBe('Открываем сессию...');
    expect(state.error).toBeNull();
  });

  test('setStage updates state and notifies listeners', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa02';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    const cb = vi.fn();
    bridge.onStateChange(cb);
    cb.mockClear();
    bridge.setStage(2, 'Auth...');
    expect(cb).toHaveBeenCalledWith({stage: 2, detail: 'Auth...', error: null, errorRecoverable: true});
  });

  test('setStage clears prior error', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa03';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.setError('Boom');
    bridge.setStage(2, 'Recovered');
    expect(bridge.getState()).toEqual({stage: 2, detail: 'Recovered', error: null, errorRecoverable: true});
  });

  test('setError preserves stage and detail', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa04';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.setStage(3, 'Loading...');
    bridge.setError('Network fail');
    expect(bridge.getState()).toEqual({stage: 3, detail: 'Loading...', error: 'Network fail', errorRecoverable: true});
  });

  test('onStateChange immediately emits current state on subscribe', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa05';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.setStage(2, 'Auth');
    const cb = vi.fn();
    bridge.onStateChange(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({stage: 2, detail: 'Auth', error: null, errorRecoverable: true});
  });

  test('unsubscribe stops further listener notifications', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa06';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    const cb = vi.fn();
    const unsub = bridge.onStateChange(cb);
    cb.mockClear();
    unsub();
    bridge.setStage(2, 'Auth');
    expect(cb).not.toHaveBeenCalled();
  });

  test('onQrToken sets stage 2 detail before fetch', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa10';
    let stateAtFetchTime: any = null;
    const fetchMock = vi.fn().mockImplementation(() => {
      stateAtFetchTime = (window as any).__panelBridge.getState();
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({jwt_for_cache: 'next'})
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    await bridge.onQrToken(new Uint8Array([0x01]));
    expect(stateAtFetchTime?.stage).toBe(2);
    expect(stateAtFetchTime?.detail).toContain('Авторизация');
  });

  test('onQrToken sets 2FA detail when password_pending=true', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa11';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({jwt_for_cache: 'next', password_pending: true})
    });
    vi.stubGlobal('fetch', fetchMock);
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    await bridge.onQrToken(new Uint8Array([0x01]));
    const state = bridge.getState();
    expect(state.stage).toBe(2);
    expect(state.detail).toContain('пароль');
  });

  test('onSessionSaved sets stage 4 \'Готово\' on success', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa12';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({})
    });
    vi.stubGlobal('fetch', fetchMock);
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    await bridge.onSessionSaved({authKeyHex: 'ab', dcId: 2, userId: 42});
    expect(bridge.getState().stage).toBe(4);
    expect(bridge.getState().detail).toBe('Готово');
  });

  test('initial state has errorRecoverable=true', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa30';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    expect(bridge.getState().errorRecoverable).toBe(true);
  });

  test('setError defaults errorRecoverable to true', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa31';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.setError('something broke');
    expect(bridge.getState().errorRecoverable).toBe(true);
  });

  test('setError({recoverable: false}) sets errorRecoverable to false', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa32';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.setError('hard fail', {recoverable: false});
    expect(bridge.getState().errorRecoverable).toBe(false);
  });

  test('setStage clears error AND resets errorRecoverable to true', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa33';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.setError('hard fail', {recoverable: false});
    expect(bridge.getState().errorRecoverable).toBe(false);

    bridge.setStage(2, 'next stage');
    expect(bridge.getState().error).toBeNull();
    expect(bridge.getState().errorRecoverable).toBe(true);
  });

  test('restoreCachedSession seeds localStorage on success', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa50';
    // 256-byte auth_key: each byte is 0xaa, hex form is 'a'.repeat(512), b64 form is btoa(string of 256 0xaa).
    const fakeAuthKeyHex = 'a'.repeat(512);
    const fakeAuthKeyBytes = new Uint8Array(256).fill(0xaa);
    let binary = '';
    for(let i = 0; i < fakeAuthKeyBytes.length; i++) binary += String.fromCharCode(fakeAuthKeyBytes[i]);
    const fakeAuthKeyB64 = btoa(binary);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        auth_key: fakeAuthKeyB64,
        dc_id: 2,
        user_id: 12345,
        jwt_for_next: 'next.jwt.token'
      })
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=initial.jwt&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();

    expect(result).toEqual({success: true});

    // Primary — account1 JSON
    const account1 = JSON.parse(localStorage.getItem('account1')!);
    expect(account1.dc2_auth_key).toBe(fakeAuthKeyHex);
    expect(account1.auth_key_fingerprint).toBe(fakeAuthKeyHex.slice(0, 8));
    expect(account1.userId).toBe(12345);
    expect(account1.dcId).toBe(2);
    expect(typeof account1.date).toBe('number');

    // Deprecated keys (legacy 'A'/'Z' versioning compat).
    // T-8: writes go through @lib/sessionStorage now, which JSON-stringifies
    // every value (LocalStorage.set at lib/localStorage.ts:76). Numbers
    // round-trip as-is (`2` → `"2"`); strings come back JSON-quoted
    // (`"hex"` → `'"hex"'`). Use JSON.parse to recover the original.
    const userAuth = JSON.parse(localStorage.getItem('user_auth')!);
    expect(userAuth.id).toBe(12345);
    expect(userAuth.dcID).toBe(2);
    expect(JSON.parse(localStorage.getItem('dc')!)).toBe(2);
    expect(JSON.parse(localStorage.getItem('auth_key_fingerprint')!)).toBe(fakeAuthKeyHex.slice(0, 8));
    expect(JSON.parse(localStorage.getItem('dc2_auth_key')!)).toBe(fakeAuthKeyHex);

    // JWT rotated
    expect((bridge as any).currentJwt).toBe('next.jwt.token');
  });

  test('restoreCachedSession returns no_cache when cached=false', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa51';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=initial.jwt&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();
    expect(result).toEqual({success: false, code: 'no_cache'});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('restoreCachedSession returns network on fetch reject', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa52';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();
    expect(result).toEqual({success: false, code: 'network'});
  });

  test('restoreCachedSession returns no_cache on 404', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa53';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404
    } as Response));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();
    expect(result).toEqual({success: false, code: 'no_cache'});
  });

  test('restoreCachedSession returns unauthorized on 401', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa54';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401
    } as Response));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();
    expect(result).toEqual({success: false, code: 'unauthorized'});
  });

  test('restoreCachedSession returns network on 5xx', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa55';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503
    } as Response));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();
    expect(result).toEqual({success: false, code: 'network'});
  });

  test('restoreCachedSession returns network when JSON body is malformed', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa56';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Unexpected token'))
    } as unknown as Response));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    const result = await bridge.restoreCachedSession();
    expect(result).toEqual({success: false, code: 'network'});
  });

  test('initPanelBridge clears stale dc{N}_auth_key from a previous account', () => {
    // Arrange — simulate leftover state from a previous account
    localStorage.setItem('dc2_auth_key', 'stale-hex-from-account-A');
    localStorage.setItem('dc4_auth_key', 'stale-hex-from-account-B');
    localStorage.setItem('dc3_server_salt', 'stale-salt');

    const uuid = '550e8400-e29b-41d4-a716-44665544aa57';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();

    expect(localStorage.getItem('dc2_auth_key')).toBeNull();
    expect(localStorage.getItem('dc4_auth_key')).toBeNull();
    expect(localStorage.getItem('dc3_server_salt')).toBeNull();
  });

  test('markCacheDead POSTs to /cache/revoke with currentJwt', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa60';
    const fetchMock = vi.fn().mockResolvedValue({ok: true} as Response);
    vi.stubGlobal('fetch', fetchMock);

    setSearch(`?jwt=rotation.jwt&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    await bridge.markCacheDead();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/v1/login/web/cache/revoke',
      expect.objectContaining({
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jwt: 'rotation.jwt'})
      })
    );
  });

  test('markCacheDead swallows network errors', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa61';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;

    // Should NOT throw
    await expect(bridge.markCacheDead()).resolves.toBeUndefined();
  });

  test('markCacheDead is a no-op when currentJwt is empty', async() => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa62';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // cached=0 — initPanelBridge does NOT kick off restoreCachedSession,
    // so the only fetch under test is the one inside markCacheDead.
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    bridge.currentJwt = '';

    await bridge.markCacheDead();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('initPanelBridge returns restorePromise when cached=1', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa71';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503
    } as Response));
    const result = initPanelBridge();
    expect(result.panelMode).toBe(true);
    expect(result.restorePromise).not.toBeNull();
  });

  test('initPanelBridge returns null restorePromise when cached=0', () => {
    const uuid = '550e8400-e29b-41d4-a716-44665544aa72';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    const result = initPanelBridge();
    expect(result.panelMode).toBe(true);
    expect(result.restorePromise).toBeNull();
  });

  test('initPanelBridge resolves DeferredIsUsingPasscode to false at boot', async() => {
    const DeferredIsUsingPasscode = (await import('../lib/passcode/deferredIsUsingPasscode')).default;
    // Reset to deferred state for this test (idempotent if already reset).
    DeferredIsUsingPasscode.resetDeferred();

    const uuid = '550e8400-e29b-41d4-a716-44665544aa80';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();

    // After init, isUsingPasscode resolves immediately to false. If the
    // boot-time resolveDeferred(false) wasn't called, this would await on
    // settings-load forever in the unit-test environment.
    const result = await DeferredIsUsingPasscode.isUsingPasscode();
    expect(result).toBe(false);
  });

  test('restoreCachedSession seed is visible via sessionStorage.get (cache populated)', async() => {
    // Direct import here only to verify cache hydration — production code
    // reads from sessionStorage indirectly via tweb's state-loader and
    // getNetworker.
    const sessionStorage = (await import('../lib/sessionStorage')).default;

    const uuid = '550e8400-e29b-41d4-a716-44665544aa70';
    const fakeAuthKeyBytes = new Uint8Array(256).fill(0xab);
    let binary = '';
    for(let i = 0; i < fakeAuthKeyBytes.length; i++) binary += String.fromCharCode(fakeAuthKeyBytes[i]);
    const fakeAuthKeyB64 = btoa(binary);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        auth_key: fakeAuthKeyB64,
        dc_id: 2,
        user_id: 99,
        jwt_for_next: 'next.jwt'
      })
    } as Response));

    setSearch(`?jwt=tok&account_id=${uuid}&cached=1`);
    initPanelBridge();
    const bridge = (window as any).__panelBridge;
    await bridge.restoreCachedSession();

    // The cache is now populated — sessionStorage.get reads from cache,
    // not raw localStorage. If the seed were still going through raw
    // localStorage.setItem, this read would return undefined (the value
    // poisoned by an earlier loadStateForAllAccounts run).
    const account1 = await sessionStorage.get('account1');
    expect(account1).toBeDefined();
    expect(account1.userId).toBe(99);
    expect(account1.dcId).toBe(2);
  });

  // T-12 ROOT-CAUSE FIX (worker context bug): the in-worker
  // accountController.update gate at accountController.ts:90
  // throws ReferenceError ('window is not defined') in SharedWorker
  // context, so bridge.onSessionSaved was never called after a real
  // QR-login. Fix: a main-thread rootScope listener for 'user_auth'
  // (which IS forwarded from worker via apiManagerProxy.ts:343)
  // reads the freshly-saved account1 snapshot and calls bridge.onSessionSaved.
  test('rootScope user_auth event triggers bridge.onSessionSaved (main-thread fallback)', async() => {
    const sessionStorage = (await import('../lib/sessionStorage')).default;
    const rootScope = (await import('../lib/rootScope')).default;

    // Pre-seed account1 with all bridge-required fields (simulating worker's
    // post-QR AccountController.update writes that completed via proxy).
    const fakeAuthKeyHex = 'ab'.repeat(256);
    await sessionStorage.set({
      account1: {
        userId: 12345,
        dcId: 2,
        date: 1700000000,
        ['dc2_auth_key']: fakeAuthKeyHex
      } as any
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({})
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const uuid = '550e8400-e29b-41d4-a716-44665544aa72';
    setSearch(`?jwt=cache_jwt_initial&account_id=${uuid}&cached=0`);
    initPanelBridge();

    // dispatchEventSingle = local-only fire, mirroring how apiManagerProxy.ts:343
    // forwards worker events into the main-thread rootScope (without re-forwarding
    // back to the worker — there's no MTProtoMessagePort in jsdom).
    rootScope.dispatchEventSingle('user_auth', {id: 12345, dcID: 2, date: 1700000000} as any);

    // Listener polls account1 — give it time to settle.
    await new Promise((r) => setTimeout(r, 250));

    const cacheCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/login/web/cache'));
    expect(cacheCall).toBeDefined();
    const [, opts] = cacheCall!;
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.jwt).toBe('cache_jwt_initial');
    expect(body.dc_id).toBe(2);
    expect(body.user_id).toBe(12345);
    expect(typeof body.auth_key).toBe('string');
    expect(body.auth_key.length).toBeGreaterThan(0);
  });

  test('user_auth listener does NOT fire when account1 lacks auth_key (defensive guard)', async() => {
    const sessionStorage = (await import('../lib/sessionStorage')).default;
    const rootScope = (await import('../lib/rootScope')).default;

    // account1 has user/dc but no dc{N}_auth_key — gate must hold.
    await sessionStorage.set({
      account1: {userId: 1, dcId: 2, date: 1700000000} as any
    });

    const fetchMock = vi.fn().mockResolvedValue({ok: true, json: () => Promise.resolve({})} as Response);
    vi.stubGlobal('fetch', fetchMock);

    const uuid = '550e8400-e29b-41d4-a716-44665544aa73';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();

    rootScope.dispatchEventSingle('user_auth', {id: 1, dcID: 2, date: 1700000000} as any);
    await new Promise((r) => setTimeout(r, 250));

    const cacheCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/login/web/cache'));
    expect(cacheCall).toBeUndefined();
  });

  test('user_auth listener fires bridge.onSessionSaved at most once (dedupe)', async() => {
    const sessionStorage = (await import('../lib/sessionStorage')).default;
    const rootScope = (await import('../lib/rootScope')).default;

    const fakeAuthKeyHex = 'cd'.repeat(256);
    await sessionStorage.set({
      account1: {
        userId: 77,
        dcId: 4,
        date: 1700000000,
        ['dc4_auth_key']: fakeAuthKeyHex
      } as any
    });

    const fetchMock = vi.fn().mockResolvedValue({ok: true, json: () => Promise.resolve({})} as Response);
    vi.stubGlobal('fetch', fetchMock);

    const uuid = '550e8400-e29b-41d4-a716-44665544aa74';
    setSearch(`?jwt=tok&account_id=${uuid}&cached=0`);
    initPanelBridge();

    // Fire twice — listener must dedupe.
    rootScope.dispatchEventSingle('user_auth', {id: 77, dcID: 4, date: 1700000000} as any);
    rootScope.dispatchEventSingle('user_auth', {id: 77, dcID: 4, date: 1700000000} as any);
    await new Promise((r) => setTimeout(r, 300));

    const cacheCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/login/web/cache'));
    expect(cacheCalls.length).toBe(1);
  });
});
