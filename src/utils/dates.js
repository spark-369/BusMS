/**
 * Local-day date helpers.
 *
 * The attendance pipeline compares rows against "today", and two mistakes are
 * easy to make here and very hard to spot in review:
 *
 *  1. `new Date('2026-02-16')` is parsed as **UTC** midnight — ECMAScript parses
 *     date-only strings as UTC — while `setHours(0, 0, 0, 0)` operates in
 *     **local** time. Mixing the two shifts a day window by one day for any
 *     timezone with a negative UTC offset, so a booking silently falls outside
 *     its own day's range.
 *  2. `date.toISOString().split('T')[0]` returns the **UTC** calendar date. For
 *     local times earlier than the UTC offset (e.g. 02:00 in UTC+6) that is still
 *     the *previous* day in UTC, so a report labelled with the wrong date.
 *
 * Everything here works in local time, so "today" means the same instant to the
 * database query, the write path and the label rendered in the UI.
 */

/** Local start of day: 00:00:00.000. */
export const startOfDay = (date = new Date()) => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
};

/** Local end of day: 23:59:59.999. */
export const endOfDay = (date = new Date()) => {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
};

/** Local start of the NEXT day. Prefer this as an exclusive upper bound. */
export const startOfNextDay = (date = new Date()) => {
  const result = startOfDay(date);
  result.setDate(result.getDate() + 1);
  return result;
};

/** Inclusive range covering exactly one local day. */
export const dayRange = (date = new Date()) => ({
  gte: startOfDay(date),
  lte: endOfDay(date),
});

/** `YYYY-MM-DD` for the LOCAL calendar date (never the UTC one). */
export const toLocalDateKey = (date = new Date()) => {
  const value = new Date(date);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
};

/**
 * Parses a `YYYY-MM-DD` value as LOCAL midnight.
 *
 * Without this, `new Date('2026-02-16')` yields UTC midnight, which lands on the
 * 15th for negative UTC offsets and therefore falls outside a local-day window.
 * Full ISO timestamps and Date objects are passed through unchanged.
 */
export const parseDateOnly = (value) => {
  if (value instanceof Date) return new Date(value);

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [year, month, day] = value.trim().split('-').map(Number);
    // Month is 0-indexed; this constructor already yields local midnight.
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  return new Date(value);
};

export default {
  startOfDay,
  endOfDay,
  startOfNextDay,
  dayRange,
  toLocalDateKey,
  parseDateOnly,
};
