// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Enumerates every local calendar day (YYYY-MM-DD in the given IANA zone)
// covered by [since, until]. Daily history endpoints zero-fill against this
// list so line charts render a continuous series instead of interpolating
// across days that simply had no rows.
export function enumerateLocalDays(
  since: Date,
  until: Date | null | undefined,
  timeZone: string,
): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const end = until ?? new Date();
  const days: string[] = [];
  const seen = new Set<string>();
  // Step by 24h and dedupe: DST transitions can repeat or skip a local day.
  for (let t = since.getTime(); t <= end.getTime(); t += 86_400_000) {
    const day = fmt.format(new Date(t));
    if (!seen.has(day)) {
      seen.add(day);
      days.push(day);
    }
  }
  const lastDay = fmt.format(end);
  if (!seen.has(lastDay)) {
    days.push(lastDay);
  }
  return days;
}

// Merges sparse per-day rows into the full day list, substituting a zero row
// for days without data. Rows outside the enumerated range are dropped.
export function zeroFillDays<T extends { date: string }>(
  days: string[],
  rows: T[],
  makeZero: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return days.map((date) => byDate.get(date) ?? makeZero(date));
}
