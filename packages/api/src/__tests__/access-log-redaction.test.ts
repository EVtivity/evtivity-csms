// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { REDACTED, redactAccessLogBody } from '../lib/access-log-redaction.js';

describe('redactAccessLogBody', () => {
  it('redacts the SAML reply and its RelayState of the SSO callback', () => {
    const out = redactAccessLogBody('/v1/auth/sso/callback', {
      SAMLResponse: 'PHNhbWxwOlJlc3BvbnNl',
      RelayState: 'state-abc',
    });
    expect(out).toEqual({ SAMLResponse: REDACTED, RelayState: REDACTED });
  });

  it('redacts the Stripe webhook signing secret and secret key on PUT /v1/settings/stripe', () => {
    const out = redactAccessLogBody('/v1/settings/stripe', {
      secretKey: 'sk_test_abc',
      webhookSecret: 'whsec_abc',
      publishableKey: 'pk_test_abc',
      preAuthAmountCents: 2000,
    });
    expect(out).toEqual({
      secretKey: REDACTED,
      webhookSecret: REDACTED,
      publishableKey: 'pk_test_abc',
      preAuthAmountCents: 2000,
    });
  });

  it('redacts credential fields outside /v1/settings by name', () => {
    expect(
      redactAccessLogBody('/v1/pnc/settings', {
        hubjectClientSecret: 's3cret',
        hubjectClientId: 'client',
      }),
    ).toEqual({ hubjectClientSecret: REDACTED, hubjectClientId: 'client' });
    expect(
      redactAccessLogBody('/v1/ocpi/partners', {
        name: 'Partner',
        partnerRegistrationToken: 'tok',
      }),
    ).toEqual({ name: 'Partner', partnerRegistrationToken: REDACTED });
    expect(
      redactAccessLogBody('/v1/users/me/ai', { provider: 'anthropic', apiKey: 'key' }),
    ).toEqual({ provider: 'anthropic', apiKey: REDACTED });
    // The SIM provider settings: the Hologram API key and the 1NCE client secret.
    expect(
      redactAccessLogBody('/v1/settings/sim-providers', {
        hologram: { enabled: true, orgId: '42', apiKey: 'holo-key' },
        '1nce': { enabled: true, clientId: 'client-1', clientSecret: 'one-secret' },
      }),
    ).toEqual({
      hologram: { enabled: true, orgId: '42', apiKey: REDACTED },
      '1nce': { enabled: true, clientId: 'client-1', clientSecret: REDACTED },
    });
    expect(redactAccessLogBody('/v1/x', { accessKeyId: 'AKIA', secretAccessKey: 'k' })).toEqual({
      accessKeyId: REDACTED,
      secretAccessKey: REDACTED,
    });
  });

  it('redacts passwords, bearer tokens, one-time codes and certificates', () => {
    expect(
      redactAccessLogBody('/v1/portal/auth/login', {
        email: 'a@b.c',
        password: 'pw',
        refreshToken: 'r',
        mfaToken: 'm',
        token: 't',
        recaptchaToken: 'c',
        code: '123456',
        certificate: '-----BEGIN',
      }),
    ).toEqual({
      email: 'a@b.c',
      password: REDACTED,
      refreshToken: REDACTED,
      mfaToken: REDACTED,
      token: REDACTED,
      recaptchaToken: REDACTED,
      code: REDACTED,
      certificate: REDACTED,
    });
  });

  it('redacts MFA recovery codes in the verify body and any list of codes', () => {
    const out = redactAccessLogBody('/v1/auth/mfa/verify', {
      mfaToken: 'jwt',
      recoveryCode: 'abcde-fghjk',
      nested: { recoveryCodes: ['abcde-fghjk', 'mnpqr-stuvw'] },
    });
    expect(out).toEqual({
      mfaToken: REDACTED,
      recoveryCode: REDACTED,
      nested: { recoveryCodes: REDACTED },
    });
  });

  it('redacts WebAuthn registration and assertion bodies', () => {
    expect(
      redactAccessLogBody('/v1/auth/webauthn/verify', {
        mfaToken: 'jwt',
        credential: { id: 'cred', response: { signature: 'sig' } },
      }),
    ).toEqual({ mfaToken: REDACTED, credential: REDACTED });
    expect(
      redactAccessLogBody('/v1/other', {
        response: {
          clientDataJSON: 'a',
          attestationObject: 'b',
          authenticatorData: 'c',
          userHandle: 'd',
        },
      }),
    ).toEqual({
      response: {
        clientDataJSON: REDACTED,
        attestationObject: REDACTED,
        authenticatorData: REDACTED,
        userHandle: REDACTED,
      },
    });
  });

  it('logs the avatar upload requests as sent: file name, type, size and the quarantine key only', () => {
    // The presigned POST policy and signature are in the reply, which is never logged.
    const upload = { fileName: 'me.jpg', contentType: 'image/jpeg', fileSize: 1234 };
    expect(redactAccessLogBody('/v1/portal/driver/avatar/upload-url', upload)).toEqual(upload);
    const confirm = {
      s3Key: 'ai-uploads/quarantine/avatars/drv_1/0b9a4c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d/avatar',
      s3Bucket: 'bucket',
    };
    expect(redactAccessLogBody('/v1/portal/driver/avatar/image', confirm)).toEqual(confirm);
  });

  it('keeps OCPP idToken identifiers and token metadata', () => {
    expect(
      redactAccessLogBody('/v1/tokens', {
        idToken: 'RFID1234',
        tokenType: 'ISO14443',
        tokenIds: ['a'],
      }),
    ).toEqual({ idToken: 'RFID1234', tokenType: 'ISO14443', tokenIds: ['a'] });
  });

  it('redacts nested secret fields and *Enc keys', () => {
    expect(
      redactAccessLogBody('/v1/x', {
        smtp: { host: 'h', passwordEnc: 'p' },
        items: [{ secret: 's', name: 'n' }],
      }),
    ).toEqual({
      smtp: { host: 'h', passwordEnc: REDACTED },
      items: [{ secret: REDACTED, name: 'n' }],
    });
  });

  it('redacts the value of a generic settings write but not elsewhere', () => {
    expect(redactAccessLogBody('/v1/settings/smtp.passwordEnc', { value: 'pw' })).toEqual({
      value: REDACTED,
    });
    expect(redactAccessLogBody('/v1/stations/abc', { value: 'kept' })).toEqual({ value: 'kept' });
  });

  it('masks station passwords in OCPP command bodies (2.1 and 1.6)', () => {
    const v21 = redactAccessLogBody('/v1/ocpp/commands/v21/SetVariables', {
      stationId: 'CS-1',
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: 'SeedStationPass1234',
        },
      ],
    });
    expect(JSON.stringify(v21)).not.toContain('SeedStationPass1234');
    const v16 = redactAccessLogBody('/v1/ocpp/commands/v16/ChangeConfiguration', {
      stationId: 'CS-1',
      key: 'AuthorizationKey',
      value: '5365656453746174',
    });
    expect(v16).toEqual({ stationId: 'CS-1', key: 'AuthorizationKey', value: '[redacted]' });
    expect(
      redactAccessLogBody('/v1/ocpp/commands/v16/ChangeConfiguration', {
        key: 'HeartbeatInterval',
        value: '300',
      }),
    ).toEqual({ key: 'HeartbeatInterval', value: '300' });
  });

  it('masks the password of file transfer URLs in OCPP command and firmware campaign bodies', () => {
    const url = 'sftp://logs:UrlSecret99@logs.example.com:22/upload';
    const masked = 'sftp://logs:[redacted]@logs.example.com:22/upload';
    expect(
      redactAccessLogBody('/v1/ocpp/commands/v21/GetLog', {
        stationId: 'CS-1',
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: url },
      }),
    ).toEqual({
      stationId: 'CS-1',
      logType: 'DiagnosticsLog',
      requestId: 1,
      log: { remoteLocation: masked },
    });
    expect(
      redactAccessLogBody('/v1/ocpp/commands/v16/GetDiagnostics', {
        stationId: 'CS-1',
        location: url,
      }),
    ).toEqual({ stationId: 'CS-1', location: masked });
    expect(
      redactAccessLogBody('/v1/ocpp/commands/v21/UpdateFirmware', {
        stationId: 'CS-1',
        requestId: 2,
        firmware: { location: url, retrieveDateTime: '2026-10-27T00:00:00Z' },
      }),
    ).toEqual({
      stationId: 'CS-1',
      requestId: 2,
      firmware: { location: masked, retrieveDateTime: '2026-10-27T00:00:00Z' },
    });
    expect(
      redactAccessLogBody('/v1/ocpp/commands/v16/UpdateFirmware', {
        stationId: 'CS-1',
        location: url,
        retrieveDate: '2026-10-27T00:00:00Z',
      }),
    ).toEqual({ stationId: 'CS-1', location: masked, retrieveDate: '2026-10-27T00:00:00Z' });
    expect(
      redactAccessLogBody('/v1/firmware-campaigns', { name: 'Fall rollout', firmwareUrl: url }),
    ).toEqual({ name: 'Fall rollout', firmwareUrl: masked });
    expect(
      redactAccessLogBody('/v1/ocpp/commands/v21/GetLog', {
        log: { remoteLocation: 'https://logs.example.com/upload' },
      }),
    ).toEqual({ log: { remoteLocation: 'https://logs.example.com/upload' } });
  });

  it('stores a URL password the masker cannot show masked as the redaction marker', () => {
    // The route refuses these with 400, but the access log stores the body.
    for (const location of [
      'ftp://logs:Pa ss99@files.example.com/up',
      'ftp://logs:Pa\tss99@files.example.com/up',
      'ftp://logs:Pa/ss99@files.example.com/up',
      'sftp://logs:Pa?ss99@files.example.com/up',
    ]) {
      const stored = redactAccessLogBody('/v1/ocpp/commands/v21/GetLog', {
        stationId: 'CS-1',
        log: { remoteLocation: location },
        note: [location],
      });
      expect(JSON.stringify(stored), location).not.toContain('ss99');
      expect(stored).toMatchObject({ stationId: 'CS-1', log: { remoteLocation: REDACTED } });
    }
  });

  it('stores only the row count of a SIM import, never its ICCIDs or IMSIs', () => {
    const rows = [
      { iccid: '8900000000000000300', imsi: '310260000000001', label: 'Kiosk', stationId: 'CS-1' },
      { iccid: '8900000000000000318', imsi: null, label: null, stationId: null },
    ];
    const out = redactAccessLogBody('/v1/sims/import', { rows, updateExisting: true });
    expect(out).toEqual({ rows: 2, updateExisting: true });
    expect(JSON.stringify(out)).not.toContain('8900000000000000300');
  });

  it('redacts an IMSI wherever it is sent', () => {
    expect(
      redactAccessLogBody('/v1/sims/:id', { label: 'Kiosk', imsi: '310260000000001' }),
    ).toEqual({ label: 'Kiosk', imsi: REDACTED });
    expect(
      redactAccessLogBody('/v1/stations/:id', {
        iccid: '8900000000000000300',
        imsi: '310260000000001',
      }),
    ).toEqual({ iccid: '8900000000000000300', imsi: REDACTED });
  });
});
