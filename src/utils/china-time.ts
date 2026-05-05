/**
 * China time (UTC+8) helpers.
 *
 * All Nova time-of-day logic runs in UTC+8 regardless of the machine's
 * local timezone, because Nova's users are in China.
 */

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Return the hour (0-23) in UTC+8 for a given millisecond timestamp. */
export function chinaHour(nowMs: number): number {
  return new Date(nowMs + CHINA_OFFSET_MS).getUTCHours();
}

/** Return the day of week (0=Sunday) in UTC+8 for a given millisecond timestamp. */
export function chinaDayOfWeek(nowMs: number): number {
  return new Date(nowMs + CHINA_OFFSET_MS).getUTCDay();
}

/** Return true if the given timestamp falls on a weekend (Sat/Sun) in UTC+8. */
export function chinaIsWeekend(nowMs: number): boolean {
  const day = chinaDayOfWeek(nowMs);
  return day === 0 || day === 6;
}

/** Return a human-readable China time of day label. */
export function describeChinaTimeOfDay(nowMs: number): string {
  const hour = chinaHour(nowMs);
  if (hour >= 6 && hour < 10) return '早晨';
  if (hour >= 10 && hour < 14) return '中午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 22) return '傍晚';
  if (hour >= 22 || hour < 2) return '深夜';
  return '凌晨';
}

/** Format a millisecond timestamp as a UTC+8 ISO-like string. */
export function chinaTimeString(nowMs: number): string {
  const d = new Date(nowMs + CHINA_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}
