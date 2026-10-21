// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Removes spacing and punctuation and adds a country code where the old rule
 * did: 10 digits, or 11 starting with 1, read as North American.
 */
export function normalizeE164(phone: string): string {
  const cleaned = phone.replace(/[\s().-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^[0-9]{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1[0-9]{10}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

/**
 * A phone number in E.164 (`+15551234567`), the one form the CSMS stores,
 * compares, counts and texts, or null when the input is not a valid number.
 * "+1 555 123 4567", "+1 (555) 123-4567" and "5551234567" give the same result;
 * a number without a country code is read as North American, as SMS sending
 * always did.
 */
export function canonicalPhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const parsed = parsePhoneNumberFromString(normalizeE164(trimmed));
  return parsed?.isValid() === true ? parsed.number : null;
}
