// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyServerRateLimit,
  clearCooldown,
  CLIENT_LIMITS,
  consume,
  formatWait,
  getCooldownRemaining,
  guard,
  peek,
  reset,
} from '@/utils/clientRateLimit';

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('formatWait', () => {
  it('renders sub-minute waits in seconds', () => {
    expect(formatWait(12_000)).toBe('12s');
    expect(formatWait(1_000)).toBe('1s');
  });

  it('renders longer waits as minutes and zero-padded seconds', () => {
    expect(formatWait(65_000)).toBe('1m 05s');
    expect(formatWait(600_000)).toBe('10m 00s');
  });

  it('rounds up so a countdown never shows 0s while still blocked', () => {
    expect(formatWait(1)).toBe('1s');
  });

  it('treats a missing value as zero', () => {
    expect(formatWait(undefined)).toBe('0s');
  });
});

describe('consume', () => {
  it('allows up to the policy limit then blocks', () => {
    const limit = CLIENT_LIMITS.login.max;

    for (let i = 0; i < limit; i += 1) {
      expect(consume('login').allowed).toBe(true);
    }

    const blocked = consume('login');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps a separate bucket per action', () => {
    // Exhaust login entirely.
    for (let i = 0; i < CLIENT_LIMITS.login.max; i += 1) consume('login');
    expect(consume('login').allowed).toBe(false);

    // register must be unaffected.
    expect(consume('register').allowed).toBe(true);
  });

  it('frees capacity as hits age out of the window', () => {
    vi.useFakeTimers();
    const limit = CLIENT_LIMITS.login.max;

    for (let i = 0; i < limit; i += 1) consume('login');
    expect(consume('login').allowed).toBe(false);

    vi.advanceTimersByTime(CLIENT_LIMITS.login.windowMs + 1);
    expect(consume('login').allowed).toBe(true);
  });

  it('persists across a page reload (sessionStorage, not memory)', () => {
    for (let i = 0; i < CLIENT_LIMITS.register.max; i += 1) consume('register');

    // A fresh module read from the same storage must still see the limit, which
    // is why state is kept in sessionStorage.
    expect(peek('register').blocked).toBe(true);
  });
});

describe('peek', () => {
  it('does not consume a token', () => {
    const before = peek('login');
    const after = peek('login');

    expect(before.remaining).toBe(after.remaining);
    expect(after.remaining).toBe(CLIENT_LIMITS.login.max);
  });

  it('reports the remaining allowance', () => {
    consume('login');
    expect(peek('login').remaining).toBe(CLIENT_LIMITS.login.max - 1);
  });

  it('falls back to api-read for an unknown action', () => {
    expect(peek('nope').limit).toBe(CLIENT_LIMITS['api-read'].max);
  });
});

describe('guard', () => {
  it('allows and consumes when under the limit', () => {
    const result = guard('login');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.message).toBeNull();
    expect(peek('login').remaining).toBe(CLIENT_LIMITS.login.max - 1);
  });

  it('reports reason "window" with a wait time once exhausted', () => {
    for (let i = 0; i < CLIENT_LIMITS.login.max; i += 1) guard('login');

    const blocked = guard('login');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('window');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.message).toMatch(/wait/i);
    // A concrete wait is shown. The regex is anchored on "wait 0s" rather than
    // /0s/, because the formatted output for a full minute is "1m 00s" — which a
    // loose /0s/ check would wrongly flag.
    expect(blocked.message).not.toMatch(/wait 0s/);
  });

  it('does not consume a token when consumeToken is false', () => {
    // This is the peek path the login/register pages use so the axios
    // interceptor stays the single token consumer.
    for (let i = 0; i < 3; i += 1) guard('login', { consumeToken: false });

    expect(peek('login').remaining).toBe(CLIENT_LIMITS.login.max);
  });

  it('still blocks in peek mode once the window is full', () => {
    for (let i = 0; i < CLIENT_LIMITS.login.max; i += 1) guard('login');

    const blocked = guard('login', { consumeToken: false });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('window');
    expect(blocked.message).toMatch(/wait/i);
  });
});

describe('applyServerRateLimit', () => {
  const errorWith = (status, headers, data) => ({
    response: { status, headers, data },
  });

  it('ignores non-429 errors', () => {
    expect(applyServerRateLimit('login', errorWith(500, {}, {}))).toBe(0);
    expect(getCooldownRemaining('login')).toBe(0);
  });

  it('installs a cooldown from Retry-After', () => {
    const cooldown = applyServerRateLimit(
      'login',
      errorWith(429, { 'retry-after': '30' }, {}),
    );

    expect(cooldown).toBe(30_000);
    expect(getCooldownRemaining('login')).toBeGreaterThan(29_000);
  });

  it('falls back to the body retryAfter when the header is absent', () => {
    expect(
      applyServerRateLimit('login', errorWith(429, {}, { retryAfter: 45 })),
    ).toBe(45_000);
  });

  it('falls back to RateLimit-Reset', () => {
    expect(
      applyServerRateLimit('login', errorWith(429, { 'ratelimit-reset': '20' }, {})),
    ).toBe(20_000);
  });

  it('falls back to the action window when the server gives no guidance', () => {
    expect(applyServerRateLimit('login', errorWith(429, {}, {}))).toBe(
      CLIENT_LIMITS.login.windowMs,
    );
  });

  it('clamps an absurd Retry-After so the UI cannot lock out for hours', () => {
    const cooldown = applyServerRateLimit(
      'login',
      errorWith(429, { 'retry-after': '999999' }, {}),
    );

    expect(cooldown).toBe(15 * 60_000);
  });

  it('enforces a minimum cooldown so a bogus 0 does not disable the limit', () => {
    expect(
      applyServerRateLimit('login', errorWith(429, { 'retry-after': '0' }, {})),
    ).toBe(CLIENT_LIMITS.login.windowMs);
  });
});

describe('cooldown interaction with guard', () => {
  it('blocks with reason "cooldown" while a server cooldown is active', () => {
    applyServerRateLimit('login', {
      response: { status: 429, headers: { 'retry-after': '60' }, data: {} },
    });

    const blocked = guard('login');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('cooldown');
    expect(blocked.cooldownMs).toBeGreaterThan(0);
  });

  it('counts down as the cooldown elapses', () => {
    vi.useFakeTimers();

    applyServerRateLimit('login', {
      response: { status: 429, headers: { 'retry-after': '10' }, data: {} },
    });

    expect(getCooldownRemaining('login')).toBeGreaterThan(9_000);

    vi.advanceTimersByTime(10_001);
    expect(getCooldownRemaining('login')).toBe(0);
    expect(guard('login').allowed).toBe(true);
  });
});

describe('reset and clearCooldown', () => {
  it('reset clears both the window and any cooldown', () => {
    for (let i = 0; i < CLIENT_LIMITS.login.max; i += 1) consume('login');
    applyServerRateLimit('login', {
      response: { status: 429, headers: { 'retry-after': '60' }, data: {} },
    });

    reset('login');

    expect(peek('login').remaining).toBe(CLIENT_LIMITS.login.max);
    expect(getCooldownRemaining('login')).toBe(0);
    expect(guard('login').allowed).toBe(true);
  });

  it('clearCooldown leaves the window counter intact', () => {
    consume('login');
    applyServerRateLimit('login', {
      response: { status: 429, headers: { 'retry-after': '60' }, data: {} },
    });

    clearCooldown('login');

    expect(getCooldownRemaining('login')).toBe(0);
    expect(peek('login').remaining).toBe(CLIENT_LIMITS.login.max - 1);
  });
});

describe('policy mirroring', () => {
  it('keeps client limits at or below the server policies', () => {
    // The client must defer *before* the server, never after — otherwise it
    // would be spending a doomed round trip.
    expect(CLIENT_LIMITS.login.max).toBeLessThanOrEqual(10);
    expect(CLIENT_LIMITS.register.max).toBeLessThanOrEqual(5);
    expect(CLIENT_LIMITS.broadcast.max).toBeLessThanOrEqual(5);
    expect(CLIENT_LIMITS['booking-create'].max).toBeLessThanOrEqual(20);
  });

  it('defines a policy for every action the UI can trigger', () => {
    for (const action of [
      'login',
      'register',
      'booking-create',
      'feedback-submit',
      'notification-send',
      'broadcast',
      'qr-verify',
      'api-read',
      'api-write',
    ]) {
      expect(CLIENT_LIMITS[action], action).toBeDefined();
      expect(CLIENT_LIMITS[action].max).toBeGreaterThan(0);
    }
  });
});
