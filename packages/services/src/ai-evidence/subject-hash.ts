// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac } from 'node:crypto';

/**
 * The keyed hash insight subjects and evidence packs use for a value that
 * must not reach a model or an insight row (a token value, a driver id):
 * HMAC-SHA256 with the server secret (`SETTINGS_ENCRYPTION_KEY`), cut to 24
 * hex characters. Without the secret the value cannot be recovered or matched
 * from the hash, so a short RFID UID or a known id cannot be looked up.
 */
export function keyedSubjectHash(value: string, secret: string): string {
  if (secret === '') throw new Error('keyedSubjectHash needs the server secret');
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 24);
}
