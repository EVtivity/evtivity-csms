// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { encryptString, decryptString } from '@evtivity/lib';
import { config as apiConfig } from './config.js';

/**
 * The `Enc` suffix is a contract: storage is AES-256-GCM ciphertext, GETs
 * decrypt before returning, and writes encrypt before storing. These helpers
 * centralize the rule so every settings route applies it identically.
 */

export function isEncryptedAtRest(key: string): boolean {
  return key.endsWith('Enc');
}

/**
 * Returns the plaintext for an *Enc key, or the value as-is for any other
 * key. Safe to call on every row in a bulk GET; non-Enc keys pass straight
 * through. Empty strings and missing encryption keys also pass through.
 */
export function decryptForRead(key: string, value: unknown): unknown {
  if (!isEncryptedAtRest(key)) return value;
  if (typeof value !== 'string' || value === '') return value;
  const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (encryptionKey === '') return value;
  return decryptString(value, encryptionKey);
}

/**
 * Encrypts plaintext bound for an *Enc key. Non-Enc keys pass through, as do
 * empty strings (clearing a setting stays clear). Throws when the
 * encryption key is missing on an *Enc write -- the caller would otherwise
 * silently store plaintext under an encrypted column.
 */
export function encryptForWrite(key: string, value: unknown): unknown {
  if (!isEncryptedAtRest(key)) return value;
  if (typeof value !== 'string' || value === '') return value;
  const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (encryptionKey === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY is required to write *Enc settings');
  }
  return encryptString(value, encryptionKey);
}
