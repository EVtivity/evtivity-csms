// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

const { touchMock, roamingMock, publishMock } = vi.hoisted(() => ({
  touchMock: vi.fn(),
  roamingMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  touchExpiredDriverTokens: touchMock,
  isRoamingEnabled: roamingMock,
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: publishMock }),
}));

import { driverTokenExpiryHandler } from '../handlers/driver-token-expiry.js';

const log = pino({ level: 'silent' });

beforeEach(() => {
  touchMock.mockReset();
  roamingMock.mockReset();
  publishMock.mockReset().mockResolvedValue(undefined);
});

describe('driverTokenExpiryHandler', () => {
  it('does nothing more when no token expired', async () => {
    touchMock.mockResolvedValue([]);
    await driverTokenExpiryHandler(log);
    expect(roamingMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('touches expired tokens but pushes nothing while roaming is off', async () => {
    touchMock.mockResolvedValue(['dtk_1']);
    roamingMock.mockResolvedValue(false);
    await driverTokenExpiryHandler(log);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('pushes the expired tokens to OCPI in chunks of 500', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `dtk_${String(i)}`);
    touchMock.mockResolvedValue(ids);
    roamingMock.mockResolvedValue(true);
    await driverTokenExpiryHandler(log);
    expect(publishMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(publishMock.mock.calls[0]?.[1] as string) as {
      type: string;
      tokenIds: string[];
    };
    expect(publishMock.mock.calls[0]?.[0]).toBe('ocpi_push');
    expect(first.type).toBe('token');
    expect(first.tokenIds).toHaveLength(500);
  });

  it('keeps going when a publish fails', async () => {
    touchMock.mockResolvedValue(['dtk_1']);
    roamingMock.mockResolvedValue(true);
    publishMock.mockRejectedValue(new Error('redis down'));
    await expect(driverTokenExpiryHandler(log)).resolves.toBeUndefined();
  });
});
