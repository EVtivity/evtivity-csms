// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { normalizedPhone } from './phone-input.js';

/** The contact fields of a driver or an operator user that MFA codes go to. */
export interface MfaContact {
  email: string | null;
  phone: string | null;
  firstName?: string | null;
  language: string;
}

export interface MfaCodeRecipient {
  email?: string;
  phone?: string;
  firstName?: string;
  language: string;
}

/**
 * The recipient of an MFA code: the channel of the chosen method only, for
 * drivers and operators alike. An email code goes by email and an SMS code by
 * SMS, so a code never reaches a channel the account did not pick as the
 * second factor.
 */
export function mfaCodeRecipient(method: string, contact: MfaContact): MfaCodeRecipient {
  const recipient: MfaCodeRecipient = { language: contact.language };
  if (contact.firstName != null) recipient.firstName = contact.firstName;
  if (method === 'sms') {
    if (contact.phone != null && contact.phone.trim() !== '') recipient.phone = contact.phone;
  } else if (contact.email != null && contact.email.trim() !== '') {
    recipient.email = contact.email;
  }
  return recipient;
}

/** Whether the account has the contact the MFA method sends codes to (TOTP needs none). */
export function hasMfaContact(
  method: string,
  contact: { email: string | null; phone: string | null },
): boolean {
  if (method === 'sms') return contact.phone != null && contact.phone.trim() !== '';
  if (method === 'email') return contact.email != null && contact.email.trim() !== '';
  return true;
}

/**
 * Whether a profile update would remove the phone an active SMS second factor
 * needs. Callers answer 400 VALIDATION_ERROR: the account would be locked out.
 */
export function removesSmsMfaPhone(
  nextPhone: string | null | undefined,
  account: { mfaEnabled: boolean; mfaMethod: string | null },
): boolean {
  if (nextPhone === undefined) return false;
  const removed = nextPhone == null || nextPhone.trim() === '';
  return removed && account.mfaEnabled && account.mfaMethod === 'sms';
}

/**
 * The destination an MFA code of the method is bound to: the account's phone
 * number (in its compared form) for an SMS code, else none. The send and the
 * check pass the same value, so an SMS code confirms only the number it went
 * to, and the per-number cap counts it.
 */
export function mfaCodeDestination(
  method: string | null,
  contact: { phone: string | null },
): string | undefined {
  if (method !== 'sms') return undefined;
  return normalizedPhone(contact.phone) ?? undefined;
}
