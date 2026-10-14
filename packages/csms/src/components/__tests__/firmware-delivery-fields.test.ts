// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import {
  EMPTY_FIRMWARE_DELIVERY,
  firmwareDeliveryPayload,
  firmwareDeliveryValue,
  getFirmwareDeliveryErrors,
} from '../FirmwareDeliveryFields.js';

const t = ((key: string) => key) as unknown as TFunction;
const NOW = new Date('2030-01-01T00:00:00');

describe('getFirmwareDeliveryErrors', () => {
  it('accepts empty fields and values in range', () => {
    expect(getFirmwareDeliveryErrors(EMPTY_FIRMWARE_DELIVERY, t, NOW)).toEqual({});
    expect(
      getFirmwareDeliveryErrors(
        { retries: '0', retryInterval: '86400', installDateTime: '2030-01-02T03:00' },
        t,
        NOW,
      ),
    ).toEqual({});
  });

  it('refuses out of range, fractional and past values', () => {
    expect(
      getFirmwareDeliveryErrors(
        { retries: '101', retryInterval: '1.5', installDateTime: '2029-12-31T23:00' },
        t,
        NOW,
      ),
    ).toEqual({
      retries: 'firmwareCampaigns.invalidRetries',
      retryInterval: 'firmwareCampaigns.invalidRetryInterval',
      installDateTime: 'firmwareCampaigns.installInPast',
    });
    expect(
      getFirmwareDeliveryErrors({ ...EMPTY_FIRMWARE_DELIVERY, retryInterval: '0' }, t, NOW),
    ).toEqual({ retryInterval: 'firmwareCampaigns.invalidRetryInterval' });
  });
});

describe('firmwareDeliveryPayload', () => {
  it('leaves empty fields out on create and clears them on edit', () => {
    expect(firmwareDeliveryPayload(EMPTY_FIRMWARE_DELIVERY, false)).toEqual({});
    expect(firmwareDeliveryPayload(EMPTY_FIRMWARE_DELIVERY, true)).toEqual({
      retries: null,
      retryInterval: null,
      installDateTime: null,
    });
  });

  it('sends numbers and an ISO install time', () => {
    const payload = firmwareDeliveryPayload(
      { retries: '3', retryInterval: '600', installDateTime: '2030-01-02T03:00' },
      false,
    );
    expect(payload.retries).toBe(3);
    expect(payload.retryInterval).toBe(600);
    expect(payload.installDateTime).toBe(new Date('2030-01-02T03:00').toISOString());
  });

  it('round-trips a stored campaign into the form', () => {
    const value = firmwareDeliveryValue({
      retries: 0,
      retryInterval: null,
      installDateTime: new Date('2030-01-02T03:00').toISOString(),
    });
    expect(value).toEqual({ retries: '0', retryInterval: '', installDateTime: '2030-01-02T03:00' });
  });
});
