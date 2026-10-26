import { beforeEach, describe, expect, it, vi } from 'vitest';

// No Redis configured -> exercises the in-memory fallback that most
// no-Redis deployments will actually use.
import {
  cacheHeaders,
  CACHE_NAMESPACES,
  cacheStatus,
  getNamespaceVersion,
  invalidate,
  invalidateNamespace,
  searchParamsKey,
  withCache,
} from '@/lib/cache';

beforeEach(() => {
  vi.useRealTimers();
});

describe('withCache (memory fallback)', () => {
  it('runs the producer on a miss and caches the result', async () => {
    const producer = vi.fn().mockResolvedValue({ buses: [1, 2, 3] });

    const first = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);
    expect(first.cache).toBe('MISS');
    expect(first.data).toEqual({ buses: [1, 2, 3] });
    expect(producer).toHaveBeenCalledTimes(1);

    const second = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);
    expect(second.cache).toBe('HIT');
    expect(second.data).toEqual({ buses: [1, 2, 3] });
    // Producer must NOT have run again — that is the whole point of the cache.
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('reports the source of a hit', async () => {
    await withCache(CACHE_NAMESPACES.ROUTES, 'default', async () => ({ routes: [] }));
    const hit = await withCache(CACHE_NAMESPACES.ROUTES, 'default', async () => {
      throw new Error('producer should not run on a hit');
    });

    expect(hit.cache).toBe('HIT');
    expect(hit.source).toBe('memory');
  });

  it('keys entries by suffix so different queries do not collide', async () => {
    await withCache(CACHE_NAMESPACES.BUSES, 'status=ACTIVE', async () => ({
      buses: ['active'],
    }));

    const other = await withCache(
      CACHE_NAMESPACES.BUSES,
      'status=INACTIVE',
      async () => ({ buses: ['inactive'] }),
    );

    expect(other.cache).toBe('MISS');
    expect(other.data).toEqual({ buses: ['inactive'] });
  });

  it('does not cache when the producer returns undefined', async () => {
    const producer = vi.fn().mockResolvedValue(undefined);

    await withCache(CACHE_NAMESPACES.TRIPS, 'default', producer);
    await withCache(CACHE_NAMESPACES.TRIPS, 'default', producer);

    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('expires entries after their TTL', async () => {
    vi.useFakeTimers();

    const producer = vi.fn().mockResolvedValue({ stops: [] });
    await withCache(CACHE_NAMESPACES.STOPS, 'default', producer);

    // `stops` has a 60s TTL.
    vi.advanceTimersByTime(60_001);

    const afterExpiry = await withCache(CACHE_NAMESPACES.STOPS, 'default', producer);
    expect(afterExpiry.cache).toBe('MISS');
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('honours an explicit ttl override', async () => {
    vi.useFakeTimers();

    const producer = vi.fn().mockResolvedValue({ ok: true });
    await withCache(CACHE_NAMESPACES.BUSES, 'default', producer, { ttl: 5 });

    vi.advanceTimersByTime(5_001);

    const afterExpiry = await withCache(CACHE_NAMESPACES.BUSES, 'default', producer, {
      ttl: 5,
    });
    expect(afterExpiry.cache).toBe('MISS');
  });

  it('propagates producer errors without caching them', async () => {
    const producer = vi.fn().mockRejectedValue(new Error('db down'));

    await expect(
      withCache(CACHE_NAMESPACES.BUSES, 'default', producer),
    ).rejects.toThrow('db down');

    // A failed read must not be cached, so the next call retries.
    await expect(
      withCache(CACHE_NAMESPACES.BUSES, 'default', producer),
    ).rejects.toThrow('db down');
    expect(producer).toHaveBeenCalledTimes(2);
  });
});

describe('invalidation', () => {
  it('invalidates a namespace via a version bump, not a key sweep', async () => {
    const producer = vi.fn().mockResolvedValue({ buses: ['old'] });
    await withCache(CACHE_NAMESPACES.BUSES, 'default', producer);

    await invalidateNamespace(CACHE_NAMESPACES.BUSES);

    const afterInvalidate = await withCache(
      CACHE_NAMESPACES.BUSES,
      'default',
      async () => ({ buses: ['new'] }),
    );

    expect(afterInvalidate.cache).toBe('MISS');
    expect(afterInvalidate.data).toEqual({ buses: ['new'] });
    // The stale entry is unreachable because its key embedded the old version.
    expect(afterInvalidate.key).toContain(':1:');
  });

  it('bumps the version counter on each invalidation', async () => {
    expect(await getNamespaceVersion(CACHE_NAMESPACES.BUSES)).toBe('0');

    await invalidateNamespace(CACHE_NAMESPACES.BUSES);
    expect(await getNamespaceVersion(CACHE_NAMESPACES.BUSES)).toBe('1');

    await invalidateNamespace(CACHE_NAMESPACES.BUSES);
    expect(await getNamespaceVersion(CACHE_NAMESPACES.BUSES)).toBe('2');
  });

  it('only clears the targeted namespace', async () => {
    await withCache(CACHE_NAMESPACES.BUSES, 'default', async () => ({ buses: [] }));
    await withCache(CACHE_NAMESPACES.ROUTES, 'default', async () => ({ routes: [] }));

    await invalidateNamespace(CACHE_NAMESPACES.BUSES);

    const routes = await withCache(CACHE_NAMESPACES.ROUTES, 'default', async () => {
      throw new Error('routes must still be cached');
    });

    expect(routes.cache).toBe('HIT');
  });

  it('accepts multiple namespaces and ignores falsy values', async () => {
    await withCache(CACHE_NAMESPACES.BUSES, 'default', async () => ({ buses: [] }));
    await withCache(CACHE_NAMESPACES.ROUTES, 'default', async () => ({ routes: [] }));

    // `undefined` must be tolerated so routes can pass a conditional list.
    await invalidate(
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.ROUTES,
      undefined,
      null,
    );

    expect(await getNamespaceVersion(CACHE_NAMESPACES.BUSES)).toBe('1');
    expect(await getNamespaceVersion(CACHE_NAMESPACES.ROUTES)).toBe('1');
  });

  it('deduplicates repeated namespaces', async () => {
    await invalidate(
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.BUSES,
      CACHE_NAMESPACES.BUSES,
    );

    expect(await getNamespaceVersion(CACHE_NAMESPACES.BUSES)).toBe('1');
  });

  it('is a no-op for a missing namespace name', async () => {
    await expect(invalidateNamespace(undefined)).resolves.toBeUndefined();
  });
});

describe('searchParamsKey', () => {
  const reqWith = (query) => new Request(`http://localhost/api/buses${query}`);

  it('returns "default" for no query string', () => {
    expect(searchParamsKey(reqWith(''))).toBe('default');
  });

  it('produces a stable key regardless of parameter order', () => {
    const a = searchParamsKey(reqWith('?b=2&a=1'));
    const b = searchParamsKey(reqWith('?a=1&b=2'));
    expect(a).toBe(b);
    expect(a).toBe('a=1&b=2');
  });

  it('distinguishes different values', () => {
    expect(searchParamsKey(reqWith('?status=ACTIVE'))).not.toBe(
      searchParamsKey(reqWith('?status=INACTIVE')),
    );
  });
});

describe('cacheHeaders', () => {
  it('emits X-Cache and the source when known', () => {
    expect(cacheHeaders({ cache: 'HIT', source: 'redis' })).toEqual({
      'X-Cache': 'HIT',
      'X-Cache-Source': 'redis',
    });
  });

  it('omits the source on a miss', () => {
    expect(cacheHeaders({ cache: 'MISS', source: null })).toEqual({
      'X-Cache': 'MISS',
    });
  });

  it('defaults to MISS for a malformed result', () => {
    expect(cacheHeaders(undefined)).toEqual({ 'X-Cache': 'MISS' });
  });
});

describe('cacheStatus', () => {
  it('reports entry count and namespace versions', async () => {
    await withCache(CACHE_NAMESPACES.BUSES, 'default', async () => ({ buses: [] }));

    // Read the entry count BEFORE invalidating: invalidation drops this
    // namespace's in-process entries, so checking afterwards would correctly
    // observe 0 and the assertion would be meaningless.
    const beforeInvalidate = cacheStatus();
    expect(beforeInvalidate.entries).toBeGreaterThan(0);

    await invalidateNamespace(CACHE_NAMESPACES.BUSES);

    const status = cacheStatus();
    expect(status.versions.buses).toBe(1);
    expect(status.defaultTtlSeconds).toBeGreaterThan(0);
  });
});
