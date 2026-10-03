// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decryptString, encryptString } from '@evtivity/lib';

const configState = vi.hoisted(() => ({ SETTINGS_ENCRYPTION_KEY: 'unit-test-key' }));
const realDecrypt = vi.hoisted(() => ({ fn: null as null | typeof decryptString }));

// decryptString is spied on so the cache test can count real decryptions.
vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  realDecrypt.fn = actual.decryptString;
  return { ...actual, decryptString: vi.fn(actual.decryptString) };
});

vi.mock('../lib/config.js', () => ({
  config: configState,
}));

import {
  isEncryptedAtRest,
  decryptForRead,
  encryptForWrite,
  clearSettingsDecryptCache,
} from '../lib/settings-crypto.js';

beforeEach(() => {
  configState.SETTINGS_ENCRYPTION_KEY = 'unit-test-key';
  clearSettingsDecryptCache();
  if (realDecrypt.fn != null) vi.mocked(decryptString).mockImplementation(realDecrypt.fn);
});

describe('isEncryptedAtRest', () => {
  it('returns true for keys ending in Enc', () => {
    expect(isEncryptedAtRest('smtp.passwordEnc')).toBe(true);
    expect(isEncryptedAtRest('stripe.secretKeyEnc')).toBe(true);
  });

  it('returns false for plain keys', () => {
    expect(isEncryptedAtRest('stripe.publishableKey')).toBe(false);
    expect(isEncryptedAtRest('company.name')).toBe(false);
  });
});

describe('encryptForWrite', () => {
  it('passes through non-Enc keys unchanged', () => {
    expect(encryptForWrite('company.name', 'EVtivity')).toBe('EVtivity');
  });

  it('passes through empty-string values for Enc keys', () => {
    expect(encryptForWrite('smtp.passwordEnc', '')).toBe('');
  });

  it('passes through non-string values for Enc keys', () => {
    expect(encryptForWrite('smtp.passwordEnc', 12345)).toBe(12345);
    expect(encryptForWrite('smtp.passwordEnc', null)).toBeNull();
  });

  it('encrypts a string value for an Enc key (produces ciphertext that round-trips)', () => {
    const cipher = encryptForWrite('smtp.passwordEnc', 'secret-pw') as string;
    expect(typeof cipher).toBe('string');
    expect(cipher).not.toBe('secret-pw');
    // Round-trips back to plaintext via decryptForRead.
    expect(decryptForRead('smtp.passwordEnc', cipher)).toBe('secret-pw');
  });

  it('throws when the encryption key is missing on an Enc write', () => {
    configState.SETTINGS_ENCRYPTION_KEY = '';
    expect(() => encryptForWrite('smtp.passwordEnc', 'secret')).toThrow(
      'SETTINGS_ENCRYPTION_KEY is required to write *Enc settings',
    );
  });
});

describe('decryptForRead', () => {
  it('passes through non-Enc keys unchanged', () => {
    expect(decryptForRead('company.name', 'EVtivity')).toBe('EVtivity');
  });

  it('passes through empty-string values for Enc keys', () => {
    expect(decryptForRead('smtp.passwordEnc', '')).toBe('');
  });

  it('passes through non-string values for Enc keys', () => {
    expect(decryptForRead('smtp.passwordEnc', 42)).toBe(42);
    expect(decryptForRead('smtp.passwordEnc', undefined)).toBeUndefined();
  });

  it('passes the ciphertext through unchanged when the encryption key is missing', () => {
    configState.SETTINGS_ENCRYPTION_KEY = '';
    const cipher = encryptString('plaintext', 'unit-test-key');
    expect(decryptForRead('smtp.passwordEnc', cipher)).toBe(cipher);
  });

  it('decrypts ciphertext for an Enc key', () => {
    const cipher = encryptString('my-secret', 'unit-test-key');
    expect(decryptForRead('smtp.passwordEnc', cipher)).toBe('my-secret');
  });

  it('caches decrypted values so the second read returns the same plaintext', () => {
    const cipher = encryptString('cached-secret', 'unit-test-key');
    const first = decryptForRead('twilio.authTokenEnc', cipher);
    const second = decryptForRead('twilio.authTokenEnc', cipher);
    expect(first).toBe('cached-secret');
    expect(second).toBe('cached-secret');
  });

  it('clearSettingsDecryptCache forces a fresh decrypt', () => {
    const cipher = encryptString('clearme', 'unit-test-key');
    expect(decryptForRead('s3.secretAccessKeyEnc', cipher)).toBe('clearme');
    clearSettingsDecryptCache();
    expect(decryptForRead('s3.secretAccessKeyEnc', cipher)).toBe('clearme');
  });

  it('evicts the least recently used entry when the cache exceeds its bound', () => {
    // A stand-in decrypt keeps 258 reads fast (real scrypt takes ~30-50ms each).
    const decrypt = vi.mocked(decryptString);
    decrypt.mockImplementation((ciphertext) => `plain:${ciphertext}`);

    // Fill the 256 entries, touch entry 0 so entry 1 becomes the oldest, then add two more.
    for (let i = 0; i < 256; i++) {
      expect(decryptForRead('smtp.passwordEnc', `cipher-${String(i)}`)).toBe(
        `plain:cipher-${String(i)}`,
      );
    }
    decryptForRead('smtp.passwordEnc', 'cipher-0');
    decryptForRead('smtp.passwordEnc', 'cipher-256');
    decryptForRead('smtp.passwordEnc', 'cipher-257');
    expect(decrypt).toHaveBeenCalledTimes(258);

    // Entry 0 was used recently and stays cached; entries 1 and 2 were evicted.
    decryptForRead('smtp.passwordEnc', 'cipher-0');
    expect(decrypt).toHaveBeenCalledTimes(258);
    expect(decryptForRead('smtp.passwordEnc', 'cipher-1')).toBe('plain:cipher-1');
    expect(decrypt).toHaveBeenCalledTimes(259);
  });
});
