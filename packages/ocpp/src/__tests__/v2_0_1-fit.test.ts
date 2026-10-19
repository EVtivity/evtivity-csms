// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { ActionRegistry as Registry201 } from '../generated/v2_0_1/registry.js';
import { ActionRegistry as Registry21 } from '../generated/v2_1/registry.js';

describe('OCPP 2.0.1 fit functions', () => {
  it('has a fitRequest and fitResponse for every 2.0.1 action', () => {
    for (const [action, entry] of Object.entries(Registry201)) {
      expect(typeof entry.fitRequest, action).toBe('function');
      expect(typeof entry.fitResponse, action).toBe('function');
    }
  });

  it('drops the 2.1-only tariff from an AuthorizeResponse and leaves the input unchanged', () => {
    const response = {
      idTokenInfo: { status: 'Accepted' },
      tariff: { tariffId: 't1', currency: 'EUR' },
    };
    expect(Registry21.Authorize.validateResponse(response)).toBe(true);
    expect(Registry201.Authorize.validateResponse(response)).toBe(false);

    const fitted = Registry201.Authorize.fitResponse(response);

    expect(fitted).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(Registry201.Authorize.validateResponse(fitted)).toBe(true);
    expect(response.tariff).toEqual({ tariffId: 't1', currency: 'EUR' });
  });

  it('drops nested 2.1-only charging profile fields of a RequestStartTransactionRequest', () => {
    const period = { startPeriod: 0, limit: 7000 };
    const schedule = { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [period] };
    const profile = {
      id: 1,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: [schedule],
    };
    const base = { remoteStartId: 1, idToken: { idToken: 'RFID-1', type: 'ISO14443' } };
    const request = {
      ...base,
      chargingProfile: {
        ...profile,
        maxOfflineDuration: 60,
        chargingSchedule: [
          { ...schedule, randomizedDelay: 5, chargingSchedulePeriod: [{ ...period, setpoint: 1 }] },
        ],
      },
    };

    const fitted = Registry201.RequestStartTransaction.fitRequest(request);

    expect(fitted).toEqual({ ...base, chargingProfile: profile });
    expect(Registry201.RequestStartTransaction.validateRequest(fitted)).toBe(true);
    expect(request.chargingProfile.maxOfflineDuration).toBe(60);
  });

  it('keeps vendor fields in customData, which the schema leaves open', () => {
    const request = {
      reason: 'PowerUp',
      chargingStation: { model: 'M', vendorName: 'V' },
      customData: { vendorId: 'acme', extra: 1 },
    };
    expect(Registry201.BootNotification.fitRequest(request)).toEqual(request);
  });
});
