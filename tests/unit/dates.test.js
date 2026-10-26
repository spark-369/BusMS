import { describe, expect, it } from 'vitest';

import {
  dayRange,
  endOfDay,
  parseDateOnly,
  startOfDay,
  startOfNextDay,
  toLocalDateKey,
} from '@/utils/dates';

/**
 * These helpers exist because two date mistakes are easy to make and very hard
 * to see in review:
 *
 *  - `new Date('2026-02-16')` is UTC midnight, while `setHours(0,0,0,0)` is
 *    local. Mixing them shifts a day window by a day for non-UTC timezones.
 *  - `toISOString().split('T')[0]` yields the UTC calendar date, which is the
 *    previous day for local times earlier than the UTC offset.
 *
 * The assertions below are timezone-agnostic: they compare against locally
 * constructed dates rather than hard-coded ISO strings, so the suite passes in
 * any TZ.
 */
describe('startOfDay / endOfDay', () => {
  it('snaps to local midnight and the last millisecond of the day', () => {
    const input = new Date(2026, 1, 16, 13, 45, 30, 500);

    const start = startOfDay(input);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(1);
    expect(start.getDate()).toBe(16);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);

    const end = endOfDay(input);
    expect(end.getDate()).toBe(16);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });

  it('defaults to now when called without arguments', () => {
    const start = startOfDay();
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(new Date().getDate());
  });

  it('does not mutate its input', () => {
    const input = new Date(2026, 1, 16, 13, 45);
    const before = input.getTime();

    startOfDay(input);
    endOfDay(input);

    expect(input.getTime()).toBe(before);
  });
});

describe('startOfNextDay', () => {
  it('is exactly one day after the local start of day', () => {
    const input = new Date(2026, 1, 16, 23, 30);

    const next = startOfNextDay(input);
    expect(next.getDate()).toBe(17);
    expect(next.getHours()).toBe(0);
    expect(next.getTime() - startOfDay(input).getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it('rolls over month boundaries', () => {
    // Feb 2026 has 28 days.
    const next = startOfNextDay(new Date(2026, 1, 28, 12, 0));
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(1);
  });

  it('rolls over year boundaries', () => {
    const next = startOfNextDay(new Date(2026, 11, 31, 12, 0));
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });
});

describe('dayRange', () => {
  it('covers the whole local day', () => {
    const { gte, lte } = dayRange(new Date(2026, 1, 16, 9, 0));

    expect(gte.getHours()).toBe(0);
    expect(lte.getHours()).toBe(23);
    expect(gte.getTime()).toBeLessThan(lte.getTime());
    expect(startOfNextDay(new Date(2026, 1, 16)).getTime()).toBeGreaterThan(
      lte.getTime(),
    );
  });
});

describe('toLocalDateKey', () => {
  it('formats the LOCAL calendar date, zero-padded', () => {
    expect(toLocalDateKey(new Date(2026, 1, 3, 8, 0))).toBe('2026-02-03');
    expect(toLocalDateKey(new Date(2026, 11, 25, 23, 0))).toBe('2026-12-25');
  });

  it('agrees with the local date even when UTC has not rolled over yet', () => {
    // 02:00 local on the 16th. In any timezone at or east of UTC this is still
    // the 15th in UTC — exactly the bug this helper replaces, where
    // `toISOString().split('T')[0]` would have returned "2026-02-15".
    const localEarlyMorning = new Date(2026, 1, 16, 2, 0);
    expect(toLocalDateKey(localEarlyMorning)).toBe('2026-02-16');

    // Only assert the divergence where the timezone actually causes it, so the
    // test stays green when run with TZ=UTC.
    if (localEarlyMorning.getTimezoneOffset() < 0) {
      expect(localEarlyMorning.toISOString().split('T')[0]).not.toBe(
        '2026-02-16',
      );
    }
  });
});

describe('parseDateOnly', () => {
  it('parses YYYY-MM-DD as LOCAL midnight, not UTC midnight', () => {
    const parsed = parseDateOnly('2026-02-16');

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(1);
    expect(parsed.getDate()).toBe(16);
    // The critical assertion: local midnight, so the calendar date cannot shift.
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getTime()).toBe(new Date(2026, 1, 16, 0, 0, 0, 0).getTime());
  });

  it('is consistent with startOfDay, which makes the booking window correct', () => {
    expect(parseDateOnly('2026-02-16').getTime()).toBe(
      startOfDay(parseDateOnly('2026-02-16')).getTime(),
    );
  });

  it('passes through a full ISO timestamp unchanged', () => {
    const iso = '2026-02-16T13:45:00.000Z';
    expect(parseDateOnly(iso).toISOString()).toBe(iso);
  });

  it('passes through a Date instance without mutating it', () => {
    const input = new Date(2026, 1, 16, 13, 45);
    const parsed = parseDateOnly(input);

    expect(parsed.getTime()).toBe(input.getTime());
    expect(parsed).not.toBe(input);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDateOnly('  2026-02-16  ').getDate()).toBe(16);
  });

  it('returns an Invalid Date for garbage so callers can guard', () => {
    expect(Number.isNaN(parseDateOnly('not-a-date').getTime())).toBe(true);
  });
});

describe('attendance arithmetic', () => {
  // Mirrors the formula in the reports route so the contract is pinned here too.
  const computeStats = (bookings) => {
    const total = bookings.length;
    const present = bookings.filter((b) => b.isUsed).length;
    const absent = total - present;
    return {
      total,
      present,
      absent,
      attendanceRate:
        total > 0 ? Math.round((present / total) * 1000) / 10 : 0,
    };
  };

  it('reports 0% (not NaN) when there are no bookings', () => {
    const stats = computeStats([]);

    expect(stats.total).toBe(0);
    expect(stats.present).toBe(0);
    expect(stats.absent).toBe(0);
    // 0/0 would be NaN; the guard is what prevents "NaN%" in the UI.
    expect(stats.attendanceRate).toBe(0);
    expect(Number.isNaN(stats.attendanceRate)).toBe(false);
  });

  it('reports 0.0% for the reported case: 1 total, 0 present, 1 absent', () => {
    const stats = computeStats([{ isUsed: false }]);

    expect(stats.total).toBe(1);
    expect(stats.present).toBe(0);
    expect(stats.absent).toBe(1);
    expect(stats.attendanceRate).toBe(0);
  });

  it('reports 100% when every booking is attended', () => {
    expect(computeStats([{ isUsed: true }, { isUsed: true }]).attendanceRate).toBe(
      100,
    );
  });

  it('rounds to one decimal place', () => {
    // 1/3 -> 33.3, not 33.33333333333333.
    expect(
      computeStats([{ isUsed: true }, { isUsed: false }, { isUsed: false }])
        .attendanceRate,
    ).toBe(33.3);
  });

  it('always satisfies total === present + absent', () => {
    const stats = computeStats([
      { isUsed: true },
      { isUsed: false },
      { isUsed: true },
    ]);

    expect(stats.total).toBe(stats.present + stats.absent);
  });

  it('never exceeds 100%', () => {
    const stats = computeStats(
      Array.from({ length: 7 }, () => ({ isUsed: true })),
    );
    expect(stats.attendanceRate).toBeLessThanOrEqual(100);
  });
});
