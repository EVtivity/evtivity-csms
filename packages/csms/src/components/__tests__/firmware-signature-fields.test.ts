// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import {
  firmwareSignaturePayload,
  getFirmwareSignatureErrors,
} from '../FirmwareSignatureFields.js';

const t = ((key: string) => key) as unknown as TFunction;
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----';

describe('getFirmwareSignatureErrors', () => {
  it('has no errors for an unsigned or a complete signed update', () => {
    expect(getFirmwareSignatureErrors({ signingCertificate: '', signature: '' }, t)).toEqual({});
    expect(
      getFirmwareSignatureErrors({ signingCertificate: PEM, signature: 'c2lnbmF0dXJl' }, t),
    ).toEqual({});
  });

  it('puts the missing-half error on the empty field', () => {
    expect(getFirmwareSignatureErrors({ signingCertificate: PEM, signature: ' ' }, t)).toEqual({
      signature: 'firmwareCampaigns.signingIncomplete',
    });
    expect(
      getFirmwareSignatureErrors({ signingCertificate: '', signature: 'c2lnbmF0dXJl' }, t),
    ).toEqual({ signingCertificate: 'firmwareCampaigns.signingIncomplete' });
  });

  it('flags a malformed certificate or signature', () => {
    expect(
      getFirmwareSignatureErrors({ signingCertificate: 'abc', signature: 'c2lnbmF0dXJl' }, t),
    ).toEqual({ signingCertificate: 'firmwareCampaigns.invalidSigningCertificate' });
    expect(getFirmwareSignatureErrors({ signingCertificate: PEM, signature: '!!' }, t)).toEqual({
      signature: 'firmwareCampaigns.invalidSignature',
    });
  });
});

describe('firmwareSignaturePayload', () => {
  it('sends trimmed fields only when both are set', () => {
    expect(
      firmwareSignaturePayload({ signingCertificate: ` ${PEM}\n`, signature: 'c2ln' }),
    ).toEqual({ signingCertificate: PEM, signature: 'c2ln' });
    expect(firmwareSignaturePayload({ signingCertificate: PEM, signature: '' })).toEqual({});
  });
});
