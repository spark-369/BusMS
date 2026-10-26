/**
 * In-memory Redis double.
 *
 * The rate limiter and cache depend on specific Redis semantics — `SET ... NX`,
 * `SET ... EX`, `INCR`, `PTTL`, and two Lua scripts. A naive stub that only
 * records calls would let a broken Lua implementation pass, so this double
 * actually *implements* the operations, including a faithful emulation of both
 * scripts.
 *
 * The Lua scripts are recognised by a signature command in their body and
 * re-implemented in JavaScript. That keeps the tests honest: assertions run
 * against real counter/sorted-set behaviour rather than a mock's return value.
 *
 * State lives in a module-level store shared by every instance, mirroring how
 * separate ioredis clients connect to one Redis server.
 */

// ---------------------------------------------------------------------------
// Shared server state
// ---------------------------------------------------------------------------
const strings = new Map(); // key -> { value: string, expiresAt: number|null }
const sortedSets = new Map(); // key -> Map<member, score>

export const resetFakeRedis = () => {
  strings.clear();
  sortedSets.clear();
};

const isExpired = (entry) =>
  entry.expiresAt !== null && entry.expiresAt <= Date.now();

const liveString = (key) => {
  const entry = strings.get(key);
  if (!entry) return null;
  if (isExpired(entry)) {
    strings.delete(key);
    return null;
  }
  return entry;
};

// ---------------------------------------------------------------------------
// Lua emulation
// ---------------------------------------------------------------------------
const runFixedWindow = (key, max, windowMs) => {
  const existing = liveString(key);
  const count = existing ? Number(existing.value) + 1 : 1;

  strings.set(key, {
    value: String(count),
    expiresAt: existing?.expiresAt ?? Date.now() + Number(windowMs),
  });

  const ttl = Math.max(
    (liveString(key)?.expiresAt ?? Date.now()) - Date.now(),
    0,
  );

  void max;
  return [count, ttl];
};

const runSlidingWindow = (key, max, windowMs, now, member) => {
  const cutoff = Number(now) - Number(windowMs);
  const set = sortedSets.get(key) || new Map();

  // ZREMRANGEBYSCORE key 0 (now - window)
  for (const [m, score] of set) {
    if (score <= cutoff) set.delete(m);
  }

  let count = set.size;

  if (count < Number(max)) {
    set.add(member);
    sortedSets.set(key, set);
    count += 1;
    // PEXPIRE is implicit here: the window trim above is what bounds the set.
    return [count, 0];
  }

  sortedSets.set(key, set);

  // ZRANGE key 0 0 WITHSCORES -> oldest member's score
  let oldestScore = null;
  for (const score of set.values()) {
    if (oldestScore === null || score < oldestScore) oldestScore = score;
  }

  const retryAfter =
    oldestScore === null
      ? Number(windowMs)
      : Math.max(oldestScore + Number(windowMs) - Number(now), 0);

  // Report the ATTEMPTED count (max + 1), not the raw ZCARD, so the caller's
  // `count <= max` check rejects this request. Mirrors SLIDING_WINDOW_SCRIPT.
  return [count + 1, retryAfter];
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export class FakeRedis {
  constructor() {
    this.status = 'ready';
    this.handlers = new Map();
    /** Set to an Error to make every command fail (simulates an outage). */
    this.failWith = null;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event, payload) {
    this.handlers.get(event)?.(payload);
  }

  #guard() {
    if (this.failWith) throw this.failWith;
  }

  async get(key) {
    this.#guard();
    return liveString(key)?.value ?? null;
  }

  async set(key, value, ...args) {
    this.#guard();

    const options = args.map((a) => String(a).toUpperCase());
    const exIndex = options.indexOf('EX');
    const ttlSeconds = exIndex !== -1 ? Number(args[exIndex + 1]) : null;

    // SET ... NX must not overwrite an existing key.
    if (options.includes('NX') && liveString(key)) return null;

    strings.set(key, {
      value: String(value),
      expiresAt: ttlSeconds === null ? null : Date.now() + ttlSeconds * 1000,
    });

    return 'OK';
  }

  async incr(key) {
    this.#guard();
    const existing = liveString(key);
    const next = existing ? Number(existing.value) + 1 : 1;

    strings.set(key, {
      value: String(next),
      expiresAt: existing?.expiresAt ?? null,
    });

    return next;
  }

  async pttl(key) {
    this.#guard();
    const entry = liveString(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(entry.expiresAt - Date.now(), 0);
  }

  async del(key) {
    this.#guard();
    sortedSets.delete(key);
    return strings.delete(key) ? 1 : 0;
  }

  /**
   * Dispatches to the JavaScript emulation of whichever Lua script was passed.
   * The scripts are identified by the Redis command they call, which keeps this
   * in sync without duplicating the script text.
   */
  async eval(script, _numKeys, key, ...args) {
    this.#guard();

    if (script.includes('ZREMRANGEBYSCORE')) {
      return runSlidingWindow(key, args[0], args[1], args[2], args[3]);
    }

    if (script.includes("redis.call('INCR'")) {
      return runFixedWindow(key, args[0], args[1]);
    }

    throw new Error('FakeRedis: unrecognised Lua script');
  }

  async ping() {
    this.#guard();
    return 'PONG';
  }

  async quit() {
    this.status = 'end';
    return 'OK';
  }

  disconnect() {
    this.status = 'end';
  }
}

/**
 * Installs nothing — this module intentionally exports only the double and its
 * reset helper.
 *
 * Correct usage, in the test file:
 *
 *     // 1. Shared mutable state must be created with `vi.hoisted`, because
 *     //    `vi.mock` factories are hoisted ABOVE the file's imports. A factory
 *     //    that closed over a plain module-scope `const` would throw
 *     //    "Cannot access 'x' before initialization".
 *     const hoisted = vi.hoisted(() => ({ instances: [] }));
 *
 *     vi.mock('ioredis', async () => {
 *       const { FakeRedis } = await import('../helpers/fakeRedis');
 *       return {
 *         default: class extends FakeRedis {
 *           constructor() { super(); hoisted.instances.push(this); }
 *         },
 *       };
 *     });
 *
 * There is deliberately no `installFakeRedis()` helper: it would have to be
 * *called* at module scope, i.e. below the hoisted factory that needs its
 * result, which is exactly the ordering bug above.
 */
export default FakeRedis;
