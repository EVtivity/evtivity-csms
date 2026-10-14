// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { REDACTED, isSecretShapedKey, redactToolText, redactToolValue } from '../redact.js';

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

  it('masks each PEM block up to its first END line and keeps the text around it', () => {
    const block = (label: string): string =>
      `-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----`;
    const text = `a ${block('CERTIFICATE')} b ${block('RSA PRIVATE KEY')} c -----BEGIN x-----`;
    const { text: out, counts } = redactToolText(text, 'chatbot');
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c -----BEGIN x-----`);
    expect(counts.values).toBe(2);
  });

  it('masks PEM blocks in linear time on many headers without an END line', () => {
    const text = '-----BEGIN  -----'.repeat(20_000);
    const started = performance.now();
    const { text: out } = redactToolText(text, 'chatbot');
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).toBe(text);
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

  it('TC-AI-DR-02 driver surface masks emails and phones and cuts token values to the last 4', () => {
    const input = {
      note: 'card 4242 4242 4242 4242, mail jane.doe@example.com',
      phone: '+1 415 555 0100',
      tokens: [{ idToken: 'AABBCCDD1234', tokenType: 'ISO14443', active: true }],
      groupIdToken: 'GROUP-9876',
      password: 'p',
      apiKey: 'k',
      description: 'Bearer abcdefghijkl1234 sk_live_abcdefghijk',
    };
    const driver = redactToolValue(input, 'driver');
    const d = driver.value as {
      note: string;
      phone: string;
      tokens: { idToken: string; tokenType: string; active: boolean }[];
      groupIdToken: string;
      description: string;
    };
    expect(d.note).toContain('j***@example.com');
    expect(d.note).toContain('****4242');
    expect(d.phone).toBe('****0100');
    expect(d.tokens[0]).toEqual({ idToken: '****1234', tokenType: 'ISO14443', active: true });
    expect(d.groupIdToken).toBe('****9876');
    expect(d).not.toHaveProperty('password');
    expect(d).not.toHaveProperty('apiKey');
    expect(d.description).not.toContain('abcdefghijkl1234');
    expect(d.description).not.toContain('sk_live_');
    expect(driver.counts.pii).toBe(5);
    expect(redactToolText('mail jane.doe@example.com', 'driver').text).toBe(
      'mail j***@example.com',
    );
  });

  it('never mutates its input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    const copy = structuredClone(input);
    redactToolValue(input, 'support');
    expect(input).toEqual(copy);
  });
});

describe('AI redactor rules added by the data handling audit (A0)', () => {
  it('masks the value of a configuration entry whose name is secret-shaped', () => {
    const input = {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: 'SeedStationPass1234',
        },
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'HeartbeatInterval' },
          attributeValue: '300',
        },
      ],
      configurationKey: [
        { key: 'AuthorizationKey', readonly: false, value: '5365656453746174' },
        { key: 'HeartbeatInterval', readonly: false, value: '300' },
      ],
      settings: [{ key: 'smtp.passwordEnc', value: 'v1:cipher' }],
      report: {
        variable: { name: 'BasicAuthPassword' },
        variableAttribute: [{ type: 'Actual', value: 'leaked' }],
      },
      station: { name: 'My Token Reader', value: 'kept' },
    };
    const { value, counts } = redactToolValue(input, 'chatbot');
    const v = value as typeof input;
    expect(v.setVariableData[0]?.attributeValue).toBe(REDACTED);
    expect(v.setVariableData[1]?.attributeValue).toBe('300');
    expect(v.configurationKey[0]?.value).toBe(REDACTED);
    expect(v.configurationKey[1]?.value).toBe('300');
    expect(v.settings[0]?.value).toBe(REDACTED);
    expect(v.report.variableAttribute[0]?.value).toBe(REDACTED);
    expect(v.station.value).toBe('kept');
    expect(counts.values).toBe(4);
  });

  it('keeps the values of auth settings that are not secrets, and never spreads into nested data', () => {
    const input = {
      getVariableResult: [
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'LocalPreAuthorization' },
          attributeValue: 'true',
        },
        {
          component: { name: 'AuthCtrlr' },
          variable: { name: 'DisableRemoteAuthorization' },
          attributeValue: 'false',
        },
      ],
      configurationKey: [{ key: 'AuthorizationCacheEnabled', value: 'true' }],
      site: { name: 'Basalt', meterValues: [{ value: '12.5' }] },
      entry: {
        key: 'AuthorizationKey',
        value: 'abc',
        meta: { value: 'kept', variableAttribute: [{ value: 'kept too' }] },
      },
    };
    const v = redactToolValue(input, 'chatbot').value as typeof input;
    expect(v.getVariableResult.map((r) => r.attributeValue)).toEqual(['true', 'false']);
    expect(v.configurationKey[0]?.value).toBe('true');
    expect(v.site.meterValues[0]?.value).toBe('12.5');
    expect(v.entry.value).toBe(REDACTED);
    expect(v.entry.meta).toEqual({ value: 'kept', variableAttribute: [{ value: 'kept too' }] });
  });

  it('treats the OCPP 1.6 idTag like an idToken', () => {
    const input = { idTag: 'SEEDTAG7788', idTagInfo: { parentIdTag: 'PARENT0001' } };
    expect(redactToolValue(input, 'chatbot').value).toEqual(input);
    const support = redactToolValue(input, 'support').value as typeof input;
    expect(support.idTag).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(support.idTagInfo.parentIdTag).toMatch(/^sha256:/);
    const driver = redactToolValue(input, 'driver').value as typeof input;
    expect(driver.idTag).toBe('****7788');
    expect(isSecretShapedKey('idTag')).toBe(false);
  });

  it('masks contiguous card numbers in text, but not timestamps, short numbers or id fields', () => {
    const text =
      'card 4242424242424242 amex 378282246310005 ms 1760140800000 n 4242424242424241 v 0.4242424242424242';
    const out = redactToolText(text, 'chatbot').text;
    expect(out).toContain('card ****4242');
    expect(out).toContain('amex ****0005');
    expect(out).toContain('1760140800000');
    expect(out).toContain('4242424242424241');
    expect(out).toContain('0.4242424242424242');
    const record = {
      transactionId: '4111111111111111',
      imsi: '262011234567890',
      ids: ['4111111111111111'],
      note: 'paid 4111111111111111',
    };
    const value = redactToolValue(record, 'chatbot').value as typeof record;
    expect(value.transactionId).toBe('4111111111111111');
    expect(value.imsi).toBe('262011234567890');
    expect(value.ids).toEqual(['4111111111111111']);
    expect(value.note).toBe('paid ****1111');
  });

  it('masks international phone numbers in text on support and driver only', () => {
    const text = 'call +49 151 23456789 or +1 (555) 123-4567, 20 kWh at +5 C';
    expect(redactToolText(text, 'chatbot').text).toBe(text);
    const support = redactToolText(text, 'support');
    expect(support.text).toBe('call ****6789 or ****4567, 20 kWh at +5 C');
    expect(support.counts.pii).toBe(2);
    const notPhones = 'up +1234.56 (12.3%) since +2026-10-11';
    expect(redactToolText(notPhones, 'support').text).toBe(notPhones);
  });

  it('serializes dates as ISO strings', () => {
    const at = new Date('2026-10-11T08:00:00.000Z');
    expect(redactToolValue({ at, bad: new Date('x') }, 'support').value).toEqual({
      at: '2026-10-11T08:00:00.000Z',
      bad: null,
    });
  });
});
