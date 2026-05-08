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

// Default startsAt: now + 5 min, rounded UP to the next 5-minute boundary.
export function getDefaultStartsAt(): string {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  d.setSeconds(0, 0);
  const remainder = d.getMinutes() % 5;
  if (remainder !== 0) d.setMinutes(d.getMinutes() + (5 - remainder));
  return formatDateTimeLocal(d);
}

// Default reservation length: 1 hour after startsAt.
export function getDefaultExpiresAt(startsAtLocal: string): string {
  const start = new Date(startsAtLocal);
  if (!Number.isFinite(start.getTime())) return '';
  return formatDateTimeLocal(new Date(start.getTime() + 60 * 60 * 1000));
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
