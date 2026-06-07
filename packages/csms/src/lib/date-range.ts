// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Local calendar date, not toISOString(): UTC conversion shifts the date by
// one day for evening users west of UTC.
export function localDateString(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(d.getFullYear())}-${m}-${day}`;
}

// The visible date window a `days=N` preset implies, mirroring the API's
// parseDateRange (since = now - N days, through today).
export function presetRange(days: number): { from: string; to: string } {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - days);
  return { from: localDateString(start), to: localDateString(today) };
}
