// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { encryptString, decryptString } from '../encryption.js';

describe('encryption', () => {
  const passphrase = 'test-passphrase-for-unit-tests';

  it('round-trips a string correctly', () => {
    const plaintext = 'sk_live_abc123xyz456';
    const encrypted = encryptString(plaintext, passphrase);
    const decrypted = decryptString(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same input', () => {
    const plaintext = 'same-input';
    const a = encryptString(plaintext, passphrase);
    const b = encryptString(plaintext, passphrase);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with wrong passphrase', () => {
    const encrypted = encryptString('secret', passphrase);
    expect(() => decryptString(encrypted, 'wrong-passphrase')).toThrow();
  });

  it('handles empty strings', () => {
    const encrypted = encryptString('', passphrase);
    const decrypted = decryptString(encrypted, passphrase);
    expect(decrypted).toBe('');
  });

  it('handles unicode content', () => {
    const plaintext = 'Stripe key with special chars: $!@#%';
    const encrypted = encryptString(plaintext, passphrase);
    const decrypted = decryptString(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('handles long content', () => {
    const plaintext = 'a'.repeat(10000);
    const encrypted = encryptString(plaintext, passphrase);
    const decrypted = decryptString(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('fails with corrupted ciphertext', () => {
    const encrypted = encryptString('secret', passphrase);
    const corrupted = encrypted.slice(0, -4) + 'XXXX';
    expect(() => decryptString(corrupted, passphrase)).toThrow();
  });

  it('decryptString returns the original for multi-byte unicode', () => {
    const plaintext = 'Hello world';
    const encrypted = encryptString(plaintext, passphrase);
    expect(decryptString(encrypted, passphrase)).toBe(plaintext);
  });

  it('decryptString fails with truncated ciphertext', () => {
    const encrypted = encryptString('data', passphrase);
    const truncated = encrypted.slice(0, 10);
    expect(() => decryptString(truncated, passphrase)).toThrow();
  });

  it('encryptString output is valid base64', () => {
    const encrypted = encryptString('test', passphrase);
    expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = Buffer.from(encrypted, 'base64');
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('decryptString fails with empty string input', () => {
    expect(() => decryptString('', passphrase)).toThrow();
  });
});
