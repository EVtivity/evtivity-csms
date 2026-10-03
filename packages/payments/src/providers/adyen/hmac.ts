// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';

/** The fields of a Standard webhook NotificationRequestItem the provider reads. */
export interface AdyenNotificationItem {
  pspReference?: string;
  originalReference?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  amount?: { value?: number; currency?: string };
  eventCode?: string;
  eventDate?: string;
  success?: string;
  reason?: string;
  paymentMethod?: string;
  additionalData?: Record<string, string | undefined>;
}

/**
 * The signed string: pspReference, originalReference, merchantAccountCode,
 * merchantReference, amount value, amount currency, eventCode and success,
 * joined with ':' and an empty string for a missing field
 * (https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures).
 */
export function adyenHmacPayload(item: AdyenNotificationItem): string {
  return [
    item.pspReference ?? '',
    item.originalReference ?? '',
    item.merchantAccountCode ?? '',
    item.merchantReference ?? '',
    item.amount?.value != null ? String(item.amount.value) : '',
    item.amount?.currency ?? '',
    item.eventCode ?? '',
    item.success ?? '',
  ].join(':');
}

/** True for a non-empty, even-length hex string (the Customer Area key format). */
export function isHexKey(key: string): boolean {
  return key.length > 0 && key.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(key);
}

/** Base64 HMAC-SHA256 of the payload under the hex-decoded key. */
export function adyenHmacSignature(item: AdyenNotificationItem, hexKey: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(hexKey, 'hex'))
    .update(adyenHmacPayload(item), 'utf8')
    .digest('base64');
}

/** True when the signature matches under any of the keys (current, then previous during rotation). */
export function isValidAdyenHmac(
  item: AdyenNotificationItem,
  signature: string,
  hexKeys: readonly string[],
): boolean {
  const given = Buffer.from(signature, 'base64');
  return hexKeys.some((key) => {
    const expected = Buffer.from(adyenHmacSignature(item, key), 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True when the Authorization header is Basic auth with this username and
 * password. Compares SHA-256 digests in constant time, so neither the length
 * nor the content leaks through timing.
 */
export function isValidBasicAuth(header: string, username: string, password: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (match?.[1] == null) return false;
  const given = Buffer.from(match[1], 'base64').toString('utf8');
  return crypto.timingSafeEqual(digest(given), digest(`${username}:${password}`));
}
