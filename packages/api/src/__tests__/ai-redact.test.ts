// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSecretShapedKey,
  redactToolText,
  redactToolValue,
} from '../services/ai/tools/redact.js';

describe('AI tool result redactor', () => {
  it('TC-AI-R-02 drops secret-shaped keys at any depth', () => {
    const input = {
      station: { id: 'sta_1', basicAuthPasswordHash: 'x', password: 'p' },
      settings: [{ key: 'smtp', passwordEnc: 'cipher', apiKey: 'k', webhook_secret: 's' }],
      tokenHash: 'h',
      accessToken: 'a',
      hmacKey: 'abc',
    };
    const { value, counts } = redactToolValue(input, 'chatbot');
    expect(value).toEqual({ station: { id: 'sta_1' }, settings: [{ key: 'smtp' }] });
    expect(counts.keys).toBe(8);
  });

  it('keeps flags, driver token ids and objects under secret-shaped names', () => {
    const input = {
      hasPassword: true,
      mustResetPassword: false,
      idToken: 'AABBCC',
      token: { id: 'dtk_1', idToken: 'AABBCC', tokenType: 'ISO14443' },
    };
    expect(redactToolValue(input, 'chatbot').value).toEqual(input);
    expect(isSecretShapedKey('hasPassword')).toBe(false);
    expect(isSecretShapedKey('groupIdToken')).toBe(false);
    expect(isSecretShapedKey('stripe.secretKeyEnc')).toBe(true);
    expect(isSecretShapedKey('client_secret')).toBe(true);
    expect(isSecretShapedKey('sessionToken')).toBe(true);
    expect(isSecretShapedKey('secretKey')).toBe(true);
    expect(isSecretShapedKey('s3.accessKeyIdEnc')).toBe(true);
    expect(isSecretShapedKey('accessKeyId')).toBe(true);
    expect(isSecretShapedKey('key')).toBe(false);
  });

  it('TC-AI-R-03 masks secret values inside strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----';
    const text = [
      `jwt ${jwt}`,
      pem,
      'sk-proj-abcdefghijklmnop',
      'sk_live_abcdefghijklmnop',
      'rk_test_abcdefghijkl',
      'whsec_abcdefghijkl',
      'AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abc.def.ghijklmnop',
      'secret: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    ].join('\n');
    const { text: out, counts } = redactToolText(text, 'chatbot');
    for (const leaked of [
      jwt,
      'MIIEv',
      'sk-proj',
      'sk_live',
      'rk_test',
      'whsec_',
      'AKIA',
      'abc.def',
      '9f86d0',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain(`secret: ${REDACTED}`);
    expect(counts.values).toBeGreaterThanOrEqual(9);
  });

  it('TC-AI-R-04 masks cards and IBANs everywhere, emails, phones and id tokens on support', () => {
    const input = {
      note: 'card 4242 4242 4242 4242, iban DE89 3704 0044 0532 0130 00, mail jane.doe@example.com',
      cardNumber: '4000056655665556',
      phone: '+1 415 555 0100',
      idToken: 'AABBCCDD',
      transactionId: '1791000000001',
    };
    const chatbot = redactToolValue(input, 'chatbot').value as Record<string, string>;
    expect(chatbot['note']).toContain('****4242');
    expect(chatbot['note']).toContain('****3000');
    expect(chatbot['note']).toContain('jane.doe@example.com');
    expect(chatbot['cardNumber']).toBe('****5556');
    expect(chatbot['phone']).toBe('+1 415 555 0100');
    expect(chatbot['idToken']).toBe('AABBCCDD');
    // An id that only looks like digits stays.
    expect(chatbot['transactionId']).toBe('1791000000001');

    const support = redactToolValue(input, 'support');
    const s = support.value as Record<string, string>;
    expect(s['note']).toContain('j***@example.com');
    expect(s['phone']).toBe('****0100');
    expect(s['idToken']).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(support.counts.pii).toBe(6);
  });

  it('never mutates its input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    const copy = structuredClone(input);
    redactToolValue(input, 'support');
    expect(input).toEqual(copy);
  });
});
