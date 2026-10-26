'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  applyServerRateLimit,
  clearCooldown,
  formatWait,
  getCooldownRemaining,
  guard as clientGuard,
  peek,
  reset as resetClientLimit,
} from '@/utils/clientRateLimit';

/**
 * Live rate-limit state for a single UI action.
 *
 * Ticks once per second only while a limit is actually blocking, so idle pages
 * do not run a timer. Returns the countdown as both a raw millisecond value and
 * a pre-formatted string, plus `guard()` to gate a submission and
 * `handleError()` to fold a server `429` back into local state.
 *
 * @param {string} action  key of `CLIENT_LIMITS`, e.g. 'login'
 */
export function useRateLimit(action) {
  const [state, setState] = useState(() => peek(action));

  const refresh = useCallback(() => {
    setState(peek(action));
  }, [action]);

  // Re-sync when the action changes (e.g. a modal switching modes).
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Count down only while blocked, then settle at zero.
  useEffect(() => {
    if (!state.blocked || state.retryAfterMs <= 0) return undefined;

    const interval = setInterval(() => {
      const next = peek(action);
      setState(next);
      if (!next.blocked) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, [action, state.blocked, state.retryAfterMs]);

  /**
   * Gate an action. Returns the guard result so callers can early-return on
   * `!allowed` and surface `result.message`.
   */
  const guard = useCallback(
    (options = {}) => {
      const result = clientGuard(action, options);
      setState(peek(action));
      return result;
    },
    [action],
  );

  /**
   * Fold an API error into local state. Installs a cooldown when the server
   * replied `429` and always returns whether the error was rate-limit related.
   */
  const handleError = useCallback(
    (error) => {
      const cooldownMs = applyServerRateLimit(action, error);
      setState(peek(action));
      return cooldownMs > 0;
    },
    [action],
  );

  /** Clear the cooldown after a successful attempt. */
  const reset = useCallback(() => {
    resetClientLimit(action);
    setState(peek(action));
  }, [action]);

  const cooldownRemaining = getCooldownRemaining(action);

  return {
    ...state,
    cooldownRemaining,
    /** Formatted countdown for display, e.g. "45s". */
    waitLabel: state.blocked ? formatWait(state.retryAfterMs || cooldownRemaining) : null,
    /** Convenience flag for disabling a submit button. */
    isLimited: state.blocked,
    guard,
    handleError,
    reset,
    clearCooldown: () => {
      clearCooldown(action);
      setState(peek(action));
    },
    refresh,
  };
}

export default useRateLimit;
