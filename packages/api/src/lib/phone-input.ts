// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { canonicalPhone } from '@evtivity/lib/phone';

/**
 * A stored phone number in the form it is compared in: E.164 when it parses,
 * so a row saved before numbers were stored in E.164 still matches the same
 * number in another spelling; else trimmed. An empty one is none.
 */
export function normalizedPhone(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  const trimmed = phone.trim();
  if (trimmed === '') return null;
  return canonicalPhone(trimmed) ?? trimmed;
}

/** A phone number of a request body: not sent, removed, a valid number, or invalid. */
export type PhoneInput =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'number'; phone: string }
  | { kind: 'invalid' };

/**
 * Reads a phone number a request writes: null or an empty string removes it, a
 * number is kept in E.164 (`canonicalPhone`), anything else is invalid. Every
 * route that stores a phone reads it here, so one number has one stored form.
 */
export function readPhoneInput(value: string | null | undefined): PhoneInput {
  if (value === undefined) return { kind: 'absent' };
  if (value === null || value.trim() === '') return { kind: 'none' };
  const phone = canonicalPhone(value);
  return phone == null ? { kind: 'invalid' } : { kind: 'number', phone };
}

/** The 400 reply of a phone number that does not parse. */
export const INVALID_PHONE_REPLY = {
  error: 'Enter a valid phone number, with its country code (such as +49 151 23456789)',
  code: 'VALIDATION_ERROR',
} as const;

/** The value to store for a read phone input (undefined: leave it). */
export function phoneToStore(input: PhoneInput): string | null | undefined {
  if (input.kind === 'number') return input.phone;
  if (input.kind === 'none') return null;
  return undefined;
}
