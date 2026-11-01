// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shared datetime helpers for reservation create flows (single + bulk).
// Pre-fill defaults align to a tidy clock minute and stay in the future even
// after a few seconds of form-fill, avoiding the foot-gun where the pre-filled
// "now" becomes a past timestamp by the time the user hits Save.

export function formatDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The first instant at or after `d` (whole minutes) that a datetime-local
// value names exactly. In the hour a fall-back DST change repeats, a
// wall-clock value always means its first occurrence, so an instant in the
// second occurrence has no value of its own; formatting it and parsing it
// back would move it an hour earlier.
export function nextRepresentableLocal(d: Date): Date {
  // Elapsed-time arithmetic only: a local setter (setSeconds, setMinutes)
  // rebuilds the instant from the wall clock and lands in the first occurrence.
  const t = new Date(Math.floor(d.getTime() / 60_000) * 60_000);
  // A DST overlap lasts at most an hour; stop well past it.
  for (let i = 0; i < 4 * 60; i++) {
    if (new Date(formatDateTimeLocal(t)).getTime() === t.getTime()) return t;
    t.setTime(t.getTime() + 60_000);
  }
  return t;
}

// Default startsAt: now + 5 min, rounded UP to the next 5-minute boundary,
// moved past a repeated DST hour it cannot name (see nextRepresentableLocal).
export function getDefaultStartsAt(): string {
  const minute = Math.floor((Date.now() + 5 * 60 * 1000) / 60_000) * 60_000;
  const remainder = new Date(minute).getMinutes() % 5;
  const d = new Date(minute + (remainder === 0 ? 0 : 5 - remainder) * 60_000);
  return formatDateTimeLocal(nextRepresentableLocal(d));
}

// Default reservation length: 1 hour of real elapsed time after startsAt, or
// the first instant after it a datetime-local value can name. Across a
// fall-back DST change, start + 1 h can fall in the repeated hour, whose
// value would read back as the start itself.
export function getDefaultExpiresAt(startsAtLocal: string): string {
  const start = new Date(startsAtLocal);
  if (!Number.isFinite(start.getTime())) return '';
  return formatDateTimeLocal(nextRepresentableLocal(new Date(start.getTime() + 60 * 60 * 1000)));
}

// Returns true when startsAt is more than 60s in the future. Used to surface
// the "scheduled" UI hint and to pick `scheduled` vs `active` semantics.
export function isStartsAtInFuture(startsAtLocal: string): boolean {
  if (startsAtLocal.trim() === '') return false;
  return new Date(startsAtLocal).getTime() > Date.now() + 60_000;
}

export interface DateRangeValidationOpts {
  startsAt: string;
  expiresAt: string;
  maxHours: number; // 0 = no cap
  startsAtRequired: boolean;
}

// Mirrors the server-side checks in routes/reservations.ts so the user sees
// errors before submit instead of after a round-trip.
export function validateReservationDateRange(opts: DateRangeValidationOpts): {
  startsAtError: string | null;
  expiresAtError: string | null;
} {
  const MIN_DURATION_MS = 60_000;
  const startsAtTrim = opts.startsAt.trim();
  const expiresAtTrim = opts.expiresAt.trim();

  if (opts.startsAtRequired && startsAtTrim === '') {
    return { startsAtError: 'required', expiresAtError: null };
  }
  if (expiresAtTrim === '') {
    return { startsAtError: null, expiresAtError: 'required' };
  }

  const expiresAtTime = new Date(expiresAtTrim).getTime();
  const startsAtTime = startsAtTrim !== '' ? new Date(startsAtTrim).getTime() : Date.now();

  if (!Number.isFinite(expiresAtTime)) {
    return { startsAtError: null, expiresAtError: 'invalid' };
  }
  if (startsAtTrim !== '' && !Number.isFinite(startsAtTime)) {
    return { startsAtError: 'invalid', expiresAtError: null };
  }

  if (startsAtTrim !== '' && startsAtTime < Date.now() - MIN_DURATION_MS) {
    return { startsAtError: 'startsInPast', expiresAtError: null };
  }
  if (expiresAtTime - Date.now() < MIN_DURATION_MS) {
    return { startsAtError: null, expiresAtError: 'expiresTooSoon' };
  }
  if (expiresAtTime - startsAtTime < MIN_DURATION_MS) {
    return { startsAtError: null, expiresAtError: 'windowTooShort' };
  }
  if (opts.maxHours > 0 && expiresAtTime - startsAtTime > opts.maxHours * 60 * 60 * 1000) {
    return { startsAtError: null, expiresAtError: 'tooLong' };
  }
  return { startsAtError: null, expiresAtError: null };
}
