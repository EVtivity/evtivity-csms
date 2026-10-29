// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// PCI scope: the CSMS keeps the last 4 digits, the BIN (first 6) and the
// brand of a card, nothing more. Every adapter reads card fields through these
// functions, so a PAN, track data or a longer digit string never passes.

const LAST4 = /^\d{4}$/;
const BIN6 = /^\d{6}$/;
const BRAND = /^[A-Za-z][A-Za-z0-9 _-]{0,29}$/;
/** A run of 12 or more digits, with optional spaces or dashes between them: PAN shaped. */
const PAN_SHAPED = /\d(?:[ -]?\d){11,}/;

/** The last 4 digits, or null for anything that is not exactly 4 digits. */
export function cardLast4(value: unknown): string | null {
  return typeof value === 'string' && LAST4.test(value) ? value : null;
}

/** The 6-digit BIN, or null for anything that is not exactly 6 digits. */
export function cardBin(value: unknown): string | null {
  return typeof value === 'string' && BIN6.test(value) ? value : null;
}

/** The card brand name (letters, digits, space, `_`, `-`, at most 30), else null. */
export function cardBrand(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return BRAND.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** True when a string holds a PAN-shaped digit run (12 or more digits). */
export function looksLikePan(value: string): boolean {
  return PAN_SHAPED.test(value);
}

/** The text with every PAN-shaped digit run replaced, for an error body that is logged. */
export function redactPanRuns(value: string): string {
  return value.replace(/\d(?:[ -]?\d){11,}/g, '[redacted]');
}

/**
 * A provider string that is shown or stored (a decline code, a reference): cut
 * to 200 characters, and null when it holds a PAN-shaped digit run, so a
 * provider that echoes card data never gets it stored.
 */
export function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 200);
  if (trimmed === '' || looksLikePan(trimmed)) return null;
  return trimmed;
}
