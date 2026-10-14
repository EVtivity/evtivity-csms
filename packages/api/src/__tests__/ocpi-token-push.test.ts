// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { roamingMock, publishMock } = vi.hoisted(() => ({
  roamingMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({ isRoamingEnabled: roamingMock }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: publishMock }),
}));

import { publishOcpiTokenPush } from '../lib/ocpi-token-push.js';

beforeEach(() => {
  roamingMock.mockReset().mockResolvedValue(true);
  publishMock.mockReset().mockResolvedValue(undefined);
});

describe('publishOcpiTokenPush', () => {
  it('publishes the changed tokens and tombstones on ocpi_push', async () => {
    await publishOcpiTokenPush({
      tokenIds: ['dtk_1'],
      tombstones: [{ idToken: 'OLD', tokenType: 'ISO14443' }],
    });
    expect(publishMock).toHaveBeenCalledWith(
      'ocpi_push',
      JSON.stringify({
        type: 'token',
        tokenIds: ['dtk_1'],
        tombstones: [{ idToken: 'OLD', tokenType: 'ISO14443' }],
      }),
    );
  });

  it('splits a large change into messages of 500 tokens', async () => {
    const tokenIds = Array.from({ length: 1001 }, (_, i) => `dtk_${String(i)}`);
    await publishOcpiTokenPush({ tokenIds });
    expect(publishMock).toHaveBeenCalledTimes(3);
  });

  it('publishes nothing for an empty change or while roaming is off', async () => {
    await publishOcpiTokenPush({});
    roamingMock.mockResolvedValue(false);
    await publishOcpiTokenPush({ tokenIds: ['dtk_1'] });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('never throws when the publish fails', async () => {
    publishMock.mockRejectedValue(new Error('redis down'));
    await expect(publishOcpiTokenPush({ tokenIds: ['dtk_1'] })).resolves.toBeUndefined();
  });
});
