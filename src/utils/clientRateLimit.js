/**
 * Manual client-side rate limiting.
 *
 * The server is always the source of truth — this module exists to avoid
 * *making* a doomed request in the first place, which is what makes the UX feel
 * responsive instead of "click, wait, get a 429".
 *
 * Two mechanisms, deliberately layered:
 *
 *  1. **Local token buckets** (`consume`) — a manual sliding-window counter per
 *     action, mirroring the server policies. Purely advisory: it protects
 *     against double-clicks, Enter-key spam and tight polling loops.
 *
 *  2. **Server-signalled cooldown** (`applyServerRateLimit`) — when the API does
 *     answer `429`, the `Retry-After` header is trusted and a hard cooldown is
 *     installed for that action. This is what actually keeps client and server
 *     in agreement, because the local bucket cannot know about other tabs,
 *     other devices, or other clients behind the same IP.
 *
 * State lives in `sessionStorage` so a page refresh does not reset a cooldown,
 * but a new tab / cleared session starts clean.
 */

const STORAGE_PREFIX = 'bus:rl:';
const COOLDOWN_PREFIX = 'bus:rlcd:';

// Mirror of the server-side policies for the actions the UI can trigger.
// Kept slightly *tighter* than the server so the client defers first.
export const CLIENT_LIMITS = {
  login: { max: 5, windowMs: 60_000 },
  register: { max: 3, windowMs: 60_000 },
  'booking-create': { max: 8, windowMs: 60_000 },
  'feedback-submit': { max: 5, windowMs: 60_000 },
  'notification-send': { max: 5, windowMs: 60_000 },
  broadcast: { max: 2, windowMs: 60_000 },
  'qr-verify': { max: 20, windowMs: 60_000 },
  'api-read': { max: 60, windowMs: 60_000 },
  'api-write': { max: 20, windowMs: 60_000 },
};

const hasStorage = () => typeof window !== 'undefined' && !!window.sessionStorage;

const readJson = (key, fallback) => {
  if (!hasStorage()) return fallback;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => {
  if (!hasStorage()) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full / disabled (private mode) — limiting becomes per-page-view.
  }
};

/** Human-readable wait time, e.g. "12s" or "1m 05s". */
export const formatWait = (ms) => {
  const totalSeconds = Math.max(Math.ceil((ms || 0) / 1000), 0);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
};

// ---------------------------------------------------------------------------
// Server-signalled cooldowns
// ---------------------------------------------------------------------------
/** Read the remaining cooldown (ms) for an action, or 0. */
export const getCooldownRemaining = (action) => {
  const until = readJson(`${COOLDOWN_PREFIX}${action}`, 0);
  return typeof until === 'number' && until > Date.now() ? until - Date.now() : 0;
};

export const clearCooldown = (action) => {
  if (!hasStorage()) return;
  window.sessionStorage.removeItem(`${COOLDOWN_PREFIX}${action}`);
};

/**
 * Install/refresh a cooldown for `action` from a server response.
 * Reads `Retry-After` first, then `retryAfter` in the body, then `X-RateLimit-Reset`.
 *
 * @param {string} action
 * @param {import('axios').AxiosError} error
 * @returns {number} cooldown installed, in ms (0 when the error was not a 429)
 */
export const applyServerRateLimit = (action, error) => {
  const response = error?.response;
  if (response?.status !== 429) return 0;

  const headers = response.headers || {};
  const body = response.data || {};

  const retryAfterSeconds = Number.parseInt(
    headers['retry-after'] ?? body.retryAfter ?? '',
    10,
  );
  const resetSeconds = Number.parseInt(headers['ratelimit-reset'] ?? '', 10);

  let cooldownMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;

  if (!cooldownMs && Number.isFinite(resetSeconds) && resetSeconds > 0) {
    cooldownMs = resetSeconds * 1000;
  }

  // Fall back to the action's window when the server sent no guidance.
  if (!cooldownMs) cooldownMs = CLIENT_LIMITS[action]?.windowMs || 60_000;

  // Never let a bogus header lock the UI out for an unreasonable time.
  cooldownMs = Math.min(Math.max(cooldownMs, 1_000), 15 * 60_000);

  writeJson(`${COOLDOWN_PREFIX}${action}`, Date.now() + cooldownMs);
  return cooldownMs;
};

// ---------------------------------------------------------------------------
// Local sliding-window limiter
// ---------------------------------------------------------------------------
/**
 * Consume one local token.
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number, limit: number }}
 */
export const consume = (action) => {
  const policy = CLIENT_LIMITS[action] || CLIENT_LIMITS['api-read'];
  const { max, windowMs } = policy;
  const now = Date.now();
  const key = `${STORAGE_PREFIX}${action}`;

  const hits = (readJson(key, []) || []).filter(
    (timestamp) => typeof timestamp === 'number' && timestamp > now - windowMs,
  );

  if (hits.length >= max) {
    writeJson(key, hits);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(hits[0] + windowMs - now, 0),
      limit: max,
    };
  }

  hits.push(now);
  writeJson(key, hits);

  return {
    allowed: true,
    remaining: max - hits.length,
    retryAfterMs: 0,
    limit: max,
  };
};

/** Full status for an action without consuming a token (for UI rendering). */
export const peek = (action) => {
  const policy = CLIENT_LIMITS[action] || CLIENT_LIMITS['api-read'];
  const now = Date.now();
  const hits = (readJson(`${STORAGE_PREFIX}${action}`, []) || []).filter(
    (timestamp) => typeof timestamp === 'number' && timestamp > now - policy.windowMs,
  );

  const cooldownMs = getCooldownRemaining(action);
  const windowRemaining = Math.max(policy.max - hits.length, 0);

  return {
    limit: policy.max,
    remaining: windowRemaining,
    windowMs: policy.windowMs,
    cooldownMs,
    blocked: cooldownMs > 0 || windowRemaining === 0,
    // Countdown target: whichever constraint releases last.
    retryAfterMs: Math.max(
      cooldownMs,
      windowRemaining === 0 ? Math.max(hits[0] + policy.windowMs - now, 0) : 0,
    ),
  };
};

/** Reset local state for an action (call after a successful login/logout). */
export const reset = (action) => {
  if (!hasStorage()) return;
  window.sessionStorage.removeItem(`${STORAGE_PREFIX}${action}`);
  window.sessionStorage.removeItem(`${COOLDOWN_PREFIX}${action}`);
};

// ---------------------------------------------------------------------------
// High-level guard
// ---------------------------------------------------------------------------
/**
 * Decide whether an action may proceed right now.
 *
 * @param {string} action
 * @param {{ consumeToken?: boolean }} [options]
 * @returns {{ allowed: boolean, reason: 'cooldown'|'window'|null, remaining: number,
 *   retryAfterMs: number, limit: number, message: string|null }}
 */
export const guard = (action, options = {}) => {
  const { consumeToken = true } = options;

  const status = peek(action);

  const cooldownMs = getCooldownRemaining(action);
  if (cooldownMs > 0) {
    return {
      ...status,
      allowed: false,
      reason: 'cooldown',
      message: `Too many attempts. Please wait ${formatWait(cooldownMs)} before trying again.`,
    };
  }

  if (!consumeToken) {
    // Peek-only: report the current window state without spending a token.
    if (status.remaining <= 0) {
      return {
        ...status,
        allowed: false,
        reason: 'window',
        message: `You've reached the limit for this action. Please wait ${formatWait(
          status.retryAfterMs,
        )}.`,
      };
    }

    return {
      ...status,
      allowed: true,
      reason: null,
      message: null,
    };
  }

  const result = consume(action);

  if (!result.allowed) {
    return {
      ...status,
      allowed: false,
      reason: 'window',
      remaining: 0,
      retryAfterMs: result.retryAfterMs,
      message: `You've reached the limit for this action. Please wait ${formatWait(
        result.retryAfterMs,
      )}.`,
    };
  }

  return {
    ...status,
    allowed: true,
    reason: null,
    limit: result.limit,
    remaining: result.remaining,
    retryAfterMs: 0,
    message: null,
  };
};

export default {
  guard,
  consume,
  peek,
  reset,
  clearCooldown,
  applyServerRateLimit,
  getCooldownRemaining,
  formatWait,
  CLIENT_LIMITS,
};
