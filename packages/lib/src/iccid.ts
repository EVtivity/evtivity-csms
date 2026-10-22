// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

const ICCID_DIGITS = /^\d{19,20}$/;

/**
 * The ICCID in the form used for comparison and provider lookup: trimmed, with
 * one trailing `F` (padding some modems report) removed. Null unless the result
 * is 19 or 20 digits. Stored values keep the form a station or operator gave.
 */
export function normalizeIccid(value: string | null | undefined): string | null {
  if (value == null) return null;
  let iccid = value.trim().toUpperCase();
  if (iccid.endsWith('F')) iccid = iccid.slice(0, -1);
  return ICCID_DIGITS.test(iccid) ? iccid : null;
}

export function isValidIccid(value: string | null | undefined): boolean {
  return normalizeIccid(value) != null;
}

/** True when both are valid ICCIDs that normalize to the same value. */
export function iccidsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeIccid(a);
  return left != null && left === normalizeIccid(b);
}

function comparableIccid(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.trim().toUpperCase();
  if (text === '') return null;
  return normalizeIccid(text) ?? text;
}

/**
 * True when a stored ICCID changes to another SIM: compared normalized (a
 * trailing F does not count), or as trimmed text when either is not a valid
 * ICCID. An empty value is no ICCID.
 */
export function iccidChanged(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return comparableIccid(before) !== comparableIccid(after);
}
