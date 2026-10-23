// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// eMAID comparison for contract certificate authorization (C07). ISO 15118
// writes an eMAID with or without separators ("DE-8EO-C12345678-9" or
// "DE8EOC123456789"), and the 15th character is an optional check digit
// (2 country, 3 provider and 9 instance characters before it). The
// contract certificate CN is the eMAID, so the CN and the idToken compare in
// this normal form: upper case, without '-' and '*', without the check digit.

const EMAID_WITHOUT_CHECK_DIGIT = 14;

export function normalizeEmaid(value: string): string {
  const compact = value.toUpperCase().replace(/[-*]/g, '');
  return compact.length === EMAID_WITHOUT_CHECK_DIGIT + 1
    ? compact.slice(0, EMAID_WITHOUT_CHECK_DIGIT)
    : compact;
}

/** True when both name the same eMAID; an empty value never matches. */
export function sameEmaid(a: string, b: string): boolean {
  const left = normalizeEmaid(a);
  return left !== '' && left === normalizeEmaid(b);
}
