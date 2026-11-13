// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { translateCommand, translateResponse } from '../server/command-translation.js';

const SCHEDULE = {
  id: 1,
  chargingRateUnit: 'A',
  chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
};

function profile(overrides: Record<string, unknown> = {}) {
  return {
    evseId: 1,
    chargingProfile: {
      id: 5,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: [SCHEDULE],
      ...overrides,
    },
  };
}

describe('SetChargingProfile to OCPP 1.6', () => {
  it('refuses a payload without a profile or a schedule', () => {
    expect(() => translateCommand('SetChargingProfile', 'ocpp1.6', { evseId: 1 })).toThrow(
      /no chargingProfile/,
    );
    expect(() =>
      translateCommand('SetChargingProfile', 'ocpp1.6', profile({ chargingSchedule: [] })),
    ).toThrow(/no charging schedule/);
  });

  it('refuses a dynamic profile and more than one schedule', () => {
    expect(() =>
      translateCommand(
        'SetChargingProfile',
        'ocpp1.6',
        profile({ chargingProfileKind: 'Dynamic' }),
      ),
    ).toThrow(/Dynamic/);
    expect(() =>
      translateCommand(
        'SetChargingProfile',
        'ocpp1.6',
        profile({ chargingSchedule: [SCHEDULE, { ...SCHEDULE, id: 2 }] }),
      ),
    ).toThrow(/exactly one charging schedule/);
  });

  it('takes a single schedule object and a numeric transaction id string', () => {
    const out = translateCommand(
      'SetChargingProfile',
      'ocpp1.6',
      profile({
        chargingSchedule: SCHEDULE,
        chargingProfilePurpose: 'TxProfile',
        transactionId: '42',
      }),
    );
    expect(out?.payload).toMatchObject({
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 5,
        transactionId: 42,
        chargingProfilePurpose: 'TxProfile',
      },
    });
  });

  it('refuses a transaction id that is not a whole number', () => {
    expect(() =>
      translateCommand('SetChargingProfile', 'ocpp1.6', profile({ transactionId: 'tx-abc' })),
    ).toThrow(/Invalid transactionId/);
  });
});

describe('DeleteCertificate replies from OCPP 1.6', () => {
  const hash = {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'a',
    issuerKeyHash: 'b',
    serialNumber: '1',
  };

  it('unwraps the status of a wrapped ISO 15118 delete, Failed when not accepted', () => {
    const request = { certificateHashData: hash, certificateType: 'V2GRootCertificate' };
    expect(
      translateResponse(
        'DeleteCertificate',
        'ocpp1.6',
        { status: 'Accepted', data: JSON.stringify({ status: 'NotFound' }) },
        request,
      ),
    ).toEqual({ status: 'NotFound' });
    expect(
      translateResponse('DeleteCertificate', 'ocpp1.6', { status: 'Rejected' }, request),
    ).toEqual({ status: 'Failed' });
  });

  it('passes a plain delete reply through', () => {
    const response = { status: 'Accepted' };
    expect(
      translateResponse('DeleteCertificate', 'ocpp1.6', response, { certificateHashData: hash }),
    ).toBe(response);
  });
});
