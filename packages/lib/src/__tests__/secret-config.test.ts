// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  MAX_MASK_DEPTH,
  MAX_URL_SCAN_LENGTH,
  REDACTED,
  holdsStationCredential,
  holdsUnmaskableUrlPassword,
  holdsUrlPassword,
  isCredentialName,
  isSecretConfigEntry,
  maskStationCredentials,
  maskUrlPassword,
  maskUrlPasswords,
  urlPasswordUnmaskable,
} from '../secret-config.js';

const PASSWORD = 'SeedStationPass1234';
const HEX = '5365656453746174696F6E50617373';

describe('station credential masking (OCPP message log)', () => {
  it('names credentials by the shared rule, and nothing else', () => {
    for (const name of [
      'BasicAuthPassword',
      'basicAuthPassword',
      'AuthorizationKey',
      'smtp.passwordEnc',
      'client_secret',
      'apiKey',
    ]) {
      expect(isCredentialName(name), name).toBe(true);
    }
    for (const name of [
      'LocalPreAuthorization',
      'DisableRemoteAuthorization',
      'AuthorizationCacheEnabled',
      'issuerKeyHash',
      'idToken',
      'HeartbeatInterval',
      'Basalt',
      'hasPassword',
      'My Password',
      42,
    ]) {
      expect(isCredentialName(name), String(name)).toBe(false);
    }
    expect(isSecretConfigEntry({ variable: { name: 'BasicAuthPassword' } })).toBe(true);
  });

  it('2.1 SetVariables request: masks BasicAuthPassword, keeps other variables', () => {
    const payload = {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: PASSWORD,
        },
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'HeartbeatInterval' },
          attributeValue: '300',
        },
      ],
    };
    const masked = maskStationCredentials(payload);
    expect(masked.setVariableData[0]?.attributeValue).toBe(REDACTED);
    expect(masked.setVariableData[0]?.variable.name).toBe('BasicAuthPassword');
    expect(masked.setVariableData[1]?.attributeValue).toBe('300');
    // Never mutates the payload the station receives.
    expect(payload.setVariableData[0]?.attributeValue).toBe(PASSWORD);
  });

  it('2.1 GetVariables response and NotifyReport: masks a reported credential value', () => {
    const response = {
      getVariableResult: [
        {
          attributeStatus: 'Accepted',
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: PASSWORD,
        },
        {
          attributeStatus: 'Accepted',
          component: { name: 'AuthCtrlr' },
          variable: { name: 'LocalPreAuthorization' },
          attributeValue: 'true',
        },
      ],
    };
    const r = maskStationCredentials(response);
    expect(r.getVariableResult.map((v) => v.attributeValue)).toEqual([REDACTED, 'true']);

    const report = {
      reportData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          variableAttribute: [{ type: 'Actual', value: PASSWORD, mutability: 'WriteOnly' }],
          variableCharacteristics: { dataType: 'passwordString', supportsMonitoring: false },
        },
      ],
    };
    const m = maskStationCredentials(report);
    expect(m.reportData[0]?.variableAttribute[0]).toEqual({
      type: 'Actual',
      value: REDACTED,
      mutability: 'WriteOnly',
    });
    expect(m.reportData[0]?.variableCharacteristics.dataType).toBe('passwordString');
  });

  it('2.1 SetNetworkProfile: masks connectionData.basicAuthPassword', () => {
    const payload = {
      configurationSlot: 2,
      connectionData: {
        ocppVersion: 'OCPP21',
        ocppCsmsUrl: 'wss://csms.example.com/ocpp',
        securityProfile: 2,
        basicAuthPassword: PASSWORD,
        messageTimeout: 30,
      },
    };
    const m = maskStationCredentials(payload);
    expect(m.connectionData.basicAuthPassword).toBe(REDACTED);
    expect(m.connectionData.ocppCsmsUrl).toBe('wss://csms.example.com/ocpp');
    expect(m.connectionData.securityProfile).toBe(2);
  });

  it('1.6 ChangeConfiguration and GetConfiguration: masks AuthorizationKey only', () => {
    expect(maskStationCredentials({ key: 'AuthorizationKey', value: HEX })).toEqual({
      key: 'AuthorizationKey',
      value: REDACTED,
    });
    expect(maskStationCredentials({ key: 'HeartbeatInterval', value: '300' })).toEqual({
      key: 'HeartbeatInterval',
      value: '300',
    });
    const response = {
      configurationKey: [
        { key: 'AuthorizationKey', readonly: false, value: HEX },
        { key: 'AuthorizationCacheEnabled', readonly: false, value: 'true' },
      ],
      unknownKey: [],
    };
    const m = maskStationCredentials(response);
    expect(m.configurationKey.map((c) => c.value)).toEqual([REDACTED, 'true']);
  });

  it('leaves messages without credentials unchanged, empty values and nested data alone', () => {
    const boot = {
      reason: 'PowerUp',
      chargingStation: { model: 'X', vendorName: 'Y', serialNumber: '4111111111111111' },
    };
    expect(maskStationCredentials(boot)).toEqual(boot);
    const authorize = { idToken: { idToken: 'RFID-1', type: 'ISO14443' } };
    expect(maskStationCredentials(authorize)).toEqual(authorize);
    expect(maskStationCredentials({ key: 'AuthorizationKey', value: '' })).toEqual({
      key: 'AuthorizationKey',
      value: '',
    });
    const entry = { key: 'AuthorizationKey', value: HEX, meta: { value: 'kept' } };
    expect(maskStationCredentials(entry).meta.value).toBe('kept');
    expect(maskStationCredentials(null)).toBeNull();
  });

  it('tells whether a payload holds a station credential', () => {
    expect(holdsStationCredential({ key: 'AuthorizationKey', value: HEX })).toBe(true);
    expect(holdsStationCredential({ connectionData: { basicAuthPassword: PASSWORD } })).toBe(true);
    expect(holdsStationCredential({ key: 'HeartbeatInterval', value: '300' })).toBe(false);
    expect(holdsStationCredential({ type: 'Soft' })).toBe(false);
  });
});

describe('maskStationCredentials nesting cap', () => {
  function nestedArrays(depth: number): unknown {
    let value: unknown = 'leaf';
    for (let i = 0; i < depth; i++) value = [value];
    return value;
  }

  it('does not overflow the stack on a deeply nested payload', () => {
    const deep = nestedArrays(20_000);
    expect(() => maskStationCredentials(deep)).not.toThrow();
  });

  it('replaces the subtree past the cap whole', () => {
    let masked = maskStationCredentials(nestedArrays(MAX_MASK_DEPTH + 5));
    for (let i = 0; i < MAX_MASK_DEPTH; i++) {
      expect(Array.isArray(masked)).toBe(true);
      masked = (masked as unknown[])[0];
    }
    expect(masked).toBe(REDACTED);
  });

  it('keeps a payload within the cap unchanged', () => {
    const payload = nestedArrays(MAX_MASK_DEPTH - 1);
    expect(maskStationCredentials(payload)).toEqual(payload);
  });
});

describe('URL userinfo passwords (OCPP file transfer URLs)', () => {
  it('masks the password and keeps scheme, user, host, port and path', () => {
    const cases: Array<[string, string]> = [
      ['ftp://user:password@host:21/fw.bin', 'ftp://user:[redacted]@host:21/fw.bin'],
      ['ftps://user:pa:ss@host/fw.bin', 'ftps://user:[redacted]@host/fw.bin'],
      [
        'sftp://logs:secret@logs.example.com:22/upload',
        'sftp://logs:[redacted]@logs.example.com:22/upload',
      ],
      ['http://u:p@host', 'http://u:[redacted]@host'],
      ['https://u:p@host/x?y=1#z', 'https://u:[redacted]@host/x?y=1#z'],
      // Percent-encoded characters, and an unencoded @ in the password: the
      // userinfo ends at the last @ of the authority.
      ['ftp://user%40corp:p%40ss%2Fw@host/x', 'ftp://user%40corp:[redacted]@host/x'],
      ['ftp://user:p@ss@host/x', 'ftp://user:[redacted]@host/x'],
      ['ftp://a@b:c@host/x', 'ftp://a@b:[redacted]@host/x'],
      // IPv6 host.
      ['sftp://u:p@[2001:db8::1]:2222/logs', 'sftp://u:[redacted]@[2001:db8::1]:2222/logs'],
      ['FTP://U:P@HOST/X', 'FTP://U:[redacted]@HOST/X'],
      // Inside free text (a status additionalInfo).
      ['upload to ftp://u:p@h/x failed', 'upload to ftp://u:[redacted]@h/x failed'],
    ];
    for (const [input, masked] of cases) {
      expect(maskUrlPassword(input), input).toBe(masked);
      expect(maskUrlPassword(masked), `idempotent ${input}`).toBe(masked);
      expect(holdsUrlPassword(input), input).toBe(true);
    }
  });

  it('leaves a userinfo without a password and text that is no URL', () => {
    for (const text of [
      'ftp://user@host/fw.bin',
      'ftp://user:@host/fw.bin',
      'ftp://user@host:21/fw.bin',
      'https://firmware.example.com/v2.5.0.bin',
      'https://[2001:db8::1]:8443/fw',
      'user:pass@host',
      'not a url',
      'mailto:user@example.com',
      '',
    ]) {
      expect(maskUrlPassword(text), text).toBe(text);
      expect(holdsUrlPassword(text), text).toBe(false);
    }
  });

  it('masks URL passwords in GetLog, GetDiagnostics, UpdateFirmware and PublishFirmware payloads', () => {
    const url = 'ftp://user:password@host:21/path';
    const masked = 'ftp://user:[redacted]@host:21/path';
    expect(
      maskStationCredentials({
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: url },
      }),
    ).toEqual({ logType: 'DiagnosticsLog', requestId: 1, log: { remoteLocation: masked } });
    expect(maskStationCredentials({ location: url, retries: 1 })).toEqual({
      location: masked,
      retries: 1,
    });
    expect(
      maskStationCredentials({ requestId: 2, firmware: { location: url, retrieveDateTime: 'x' } }),
    ).toEqual({ requestId: 2, firmware: { location: masked, retrieveDateTime: 'x' } });
    expect(maskStationCredentials([url])).toEqual([masked]);
    expect(maskStationCredentials(url)).toBe(masked);
    expect(maskUrlPasswords({ request: { log: { remoteLocation: url } }, n: 1, at: null })).toEqual(
      { request: { log: { remoteLocation: masked } }, n: 1, at: null },
    );
  });

  it('masks a password holding a quote, a backslash, an @, a colon, unicode or many characters', () => {
    const long = 'x'.repeat(5000);
    const cases: Array<[string, string]> = [
      // A quote and a backslash ended the earlier pattern, which left them in plain text.
      ['ftp://user:pa"ss@host/fw.bin', 'ftp://user:[redacted]@host/fw.bin'],
      ['ftp://user:pa\\ss@host/fw.bin', 'ftp://user:[redacted]@host/fw.bin'],
      ['sftp://user:pa\\ss@host/up', 'sftp://user:[redacted]@host/up'],
      ['ftp://user:"\\"@host/x', 'ftp://user:[redacted]@host/x'],
      ['ftp://user:pa\\ss"x@y@host/x', 'ftp://user:[redacted]@host/x'],
      // Raw and encoded @, a colon in the password.
      ['ftp://user:p@ss@w@host/x', 'ftp://user:[redacted]@host/x'],
      ['ftp://user:p%40ss@host/x', 'ftp://user:[redacted]@host/x'],
      ['ftp://user:a:b:c@host/x', 'ftp://user:[redacted]@host/x'],
      // Unicode and a very long password.
      ['ftp://user:pässwörd€😀@host/x', 'ftp://user:[redacted]@host/x'],
      [`ftp://user:${long}@host/x`, 'ftp://user:[redacted]@host/x'],
      // The masker reads decoded string values: a quote is a password character.
      ['see ftp://u:p"q@h/x', 'see ftp://u:[redacted]@h/x'],
    ];
    for (const [input, masked] of cases) {
      expect(maskUrlPassword(input), input).toBe(masked);
      expect(maskUrlPassword(masked), `idempotent ${input}`).toBe(masked);
      expect(maskStationCredentials({ log: { remoteLocation: input } })).toEqual({
        log: { remoteLocation: masked },
      });
      expect(maskUrlPasswords({ firmware: { location: input } })).toEqual({
        firmware: { location: masked },
      });
    }
    for (const text of ['ftp://user@host/x', 'ftp://us"er\\x@host/x', 'ftp://h:21/fw.bin']) {
      expect(maskUrlPassword(text), text).toBe(text);
    }
  });

  it('masks a userinfo holding /, ? or # up to the last @ before whitespace', () => {
    // Parsers disagree on where such an authority ends, so the stored copies
    // mask through to the last @ of the URL (over-masking a path @ is fine).
    const cases: Array<[string, string]> = [
      ['ftp://user:pa/ss@host/fw.bin', 'ftp://user:[redacted]@host/fw.bin'],
      ['sftp://u:p?x@h', 'sftp://u:[redacted]@h'],
      ['ftp://u:p#x@h', 'ftp://u:[redacted]@h'],
      ['ftp://u:p/a?b#c@h/x failed, retry', 'ftp://u:[redacted]@h/x failed, retry'],
      ['ftp://h:21/a:b@c', 'ftp://h:[redacted]@c'],
    ];
    for (const [input, masked] of cases) {
      expect(maskUrlPassword(input), input).toBe(masked);
      expect(maskUrlPassword(masked), `idempotent ${input}`).toBe(masked);
    }
  });

  it('scans crafted input in linear time (no regex backtracking)', () => {
    // Worst cases of the earlier patterns: many `scheme://user:` starts with
    // no @ (each start ran to the end and backed off), and a / before no @.
    const inputs = [
      'a://u:'.repeat(10_000),
      'a://u:/'.repeat(9_000),
      `a://u:${'x'.repeat(60_000)}`,
      `${'a'.repeat(30_000)}://u:${'/'.repeat(30_000)}`,
      'a://x:'.repeat(5_000) + '@',
    ];
    for (const input of inputs) {
      expect(input.length).toBeLessThanOrEqual(MAX_URL_SCAN_LENGTH);
      const started = performance.now();
      maskUrlPassword(input);
      urlPasswordUnmaskable(input);
      maskStationCredentials({ log: { remoteLocation: input } });
      const elapsed = performance.now() - started;
      expect(elapsed, `${input.slice(0, 12)}... ${String(input.length)}`).toBeLessThan(50);
    }
  });

  it('scans exactly as the reference patterns read on short random strings', () => {
    // The earlier regular expressions, safe on short input, as the reference.
    // eslint-disable-next-line no-control-regex -- the reference pattern
    const mask = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\x00-\x20/?#:]*:)[^\x00-\x20]+@/g;
    const ambiguous =
      // eslint-disable-next-line no-control-regex -- the reference pattern
      /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\x00-\x20/?#:]*:[^\x00-\x20@]*[/?#][^\x00-\x20]*@/;
    const alphabet = [
      'a',
      'b',
      '1',
      '.',
      ':',
      '/',
      '//',
      '://',
      '@',
      '?',
      '#',
      ' ',
      '\\',
      '"',
      'é',
    ];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 20_000; n++) {
      let text = '';
      const parts = 1 + (next() % 14);
      for (let p = 0; p < parts; p++) text += alphabet[next() % alphabet.length] ?? '';
      expect(maskUrlPassword(text), JSON.stringify(text)).toBe(
        text.replace(mask, `$1${REDACTED}@`),
      );
      if (!text.includes(' ')) {
        expect(urlPasswordUnmaskable(text), JSON.stringify(text)).toBe(ambiguous.test(text));
      }
    }
  });

  it('redacts whole, and refuses on write, a URL-bearing string past the scan bound', () => {
    const long = `ftp://u:p@h/${'x'.repeat(MAX_URL_SCAN_LENGTH)}`;
    expect(maskUrlPassword(long)).toBe(REDACTED);
    expect(maskUrlPasswords({ a: long })).toEqual({ a: REDACTED });
    expect(urlPasswordUnmaskable(long)).toBe(true);
    // Breaks inside the scheme separator hide `://` from a literal check,
    // and parsers drop them: any long string with a colon is replaced whole.
    for (const hidden of [
      `ftp:/ /user:pass@host/${'x'.repeat(MAX_URL_SCAN_LENGTH)}`,
      `ftp:\t//user:pass@host/${'x'.repeat(MAX_URL_SCAN_LENGTH)}`,
      `ftp:/\n/user:pass@host/${'x'.repeat(MAX_URL_SCAN_LENGTH)}`,
    ]) {
      expect(urlPasswordUnmaskable(hidden)).toBe(true);
      expect(maskUrlPassword(hidden)).toBe(REDACTED);
      expect(maskStationCredentials({ location: hidden })).toEqual({ location: REDACTED });
    }
    // A long string with no URL is left as it is.
    const plain = 'x'.repeat(MAX_URL_SCAN_LENGTH + 1);
    expect(maskUrlPassword(plain)).toBe(plain);
    expect(urlPasswordUnmaskable(plain)).toBe(false);
  });

  it('refuses on write a userinfo holding /, ? or # before an @', () => {
    for (const url of [
      'ftp://user:pa/ss@host/fw.bin',
      'sftp://u:p?x@h',
      'ftp://u:p#x@h',
      'ftp://host:21/a@b',
    ]) {
      expect(urlPasswordUnmaskable(url), url).toBe(true);
    }
    for (const url of [
      'ftp://user:pa%2Fss@host/fw.bin',
      'ftp://host:21/fw.bin',
      'ftp://user@host/a@b',
      'https://h/x?y=a@b',
    ]) {
      expect(urlPasswordUnmaskable(url), url).toBe(false);
    }
  });

  it('masks at least what the WHATWG URL parser reads as the password', () => {
    // The authority ends at the first /, ? or #; the userinfo is everything
    // before its last @; the password follows the first : of the userinfo.
    for (const url of [
      'ftp://user:pa"ss@host/fw.bin',
      'sftp://user:pa\\ss@host/up',
      'ftp://user:p@ss@w@host/x',
      'ftp://a@b:c@host/x',
      'ftp://user:a:b:c@host:21/x?y#z',
      'ftps://u:pässwörd@host/x',
    ]) {
      const parsed = new URL(url);
      expect(parsed.password.length, url).toBeGreaterThan(0);
      const masked = new URL(maskUrlPassword(url));
      expect(decodeURIComponent(masked.password), url).toBe(REDACTED);
      expect(masked.username, url).toBe(parsed.username);
      expect(masked.host, url).toBe(parsed.host);
      expect(masked.pathname, url).toBe(parsed.pathname);
    }
  });

  it('finds a URL password the masker cannot show masked (whitespace or a control inside)', () => {
    for (const url of [
      'ftp://user:pa ss@host/x',
      'ftp://user:pa\tss@host/x',
      'ftp://user:pa\nss@host/x',
      'ft\tp://user:pass@host/x',
      'ftp:/\t/user:pass@host/x',
    ]) {
      expect(urlPasswordUnmaskable(url), JSON.stringify(url)).toBe(true);
    }
    for (const url of [
      'ftp://user:pass@host/x',
      ' ftp://user:pass@host/x ',
      'ftp://user:pa"ss@host/x',
      'ftp://user@host/a b',
      'https://firmware.example.com/fw 1.bin',
      'not a url',
    ]) {
      expect(urlPasswordUnmaskable(url), JSON.stringify(url)).toBe(false);
    }
    expect(holdsUnmaskableUrlPassword({ log: { remoteLocation: 'ftp://u:p q@h/x' } })).toBe(true);
    expect(holdsUnmaskableUrlPassword([{ location: 'ftp://u:pq@h/x' }, 1, null])).toBe(false);
  });

  it('does not count a URL password as a station credential (the command is still queued)', () => {
    expect(holdsStationCredential({ firmware: { location: 'ftp://u:p@h/x' } })).toBe(false);
    expect(
      holdsStationCredential({
        setVariableData: [
          {
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'BasicAuthPassword' },
            attributeValue: 'x',
          },
        ],
      }),
    ).toBe(true);
  });
});
