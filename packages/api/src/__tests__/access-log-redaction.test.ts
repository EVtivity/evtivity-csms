// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { REDACTED, redactAccessLogBody } from '../lib/access-log-redaction.js';

describe('redactAccessLogBody', () => {
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
});
