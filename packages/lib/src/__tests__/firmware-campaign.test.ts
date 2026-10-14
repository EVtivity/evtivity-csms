// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildCampaignUpdateFirmware } from '../firmware-campaign.js';

const BASE = {
  firmwareUrl: 'https://fw.example/v2.bin',
  signingCertificate: null,
  signature: null,
  retries: null,
  retryInterval: null,
  installDateTime: null,
};
const RETRIEVE = new Date('2030-01-01T00:00:00.000Z');

describe('buildCampaignUpdateFirmware', () => {
  it('leaves retries, interval and install time to the station when unset', () => {
    expect(buildCampaignUpdateFirmware(BASE, 7, RETRIEVE)).toEqual({
      requestId: 7,
      firmware: { location: BASE.firmwareUrl, retrieveDateTime: '2030-01-01T00:00:00.000Z' },
    });
  });

  it('sends retries 0 (no retries), the interval and the install time', () => {
    const payload = buildCampaignUpdateFirmware(
      { ...BASE, retries: 0, retryInterval: 120, installDateTime: '2030-01-02T03:00:00Z' },
      8,
      RETRIEVE,
    );
    expect(payload).toMatchObject({
      retries: 0,
      retryInterval: 120,
      firmware: { installDateTime: '2030-01-02T03:00:00.000Z' },
    });
  });

  it('sends the signing certificate and signature only together', () => {
    const half = buildCampaignUpdateFirmware({ ...BASE, signature: 'c2ln' }, 9, RETRIEVE);
    expect(half.firmware).not.toHaveProperty('signature');
    const signed = buildCampaignUpdateFirmware(
      { ...BASE, signingCertificate: 'PEM', signature: 'c2ln' },
      9,
      RETRIEVE,
    );
    expect(signed.firmware).toMatchObject({ signingCertificate: 'PEM', signature: 'c2ln' });
  });
});
