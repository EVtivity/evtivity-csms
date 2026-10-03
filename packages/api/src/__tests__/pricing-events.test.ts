// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  isRoamingEnabled: vi.fn(),
}));

vi.mock('../lib/pubsub.js', () => ({ getPubSub: () => ({ publish: mocks.publish }) }));
vi.mock('@evtivity/database', () => ({ isRoamingEnabled: mocks.isRoamingEnabled }));

const { publishPricingChanged } = await import('../lib/pricing-events.js');

function ocpiPushes(): unknown[] {
  return mocks.publish.mock.calls
    .filter(([channel]) => channel === 'ocpi_push')
    .map(([, payload]) => JSON.parse(payload as string) as unknown);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRoamingEnabled.mockResolvedValue(true);
});

describe('publishPricingChanged', () => {
  it('asks the OCPI server to push the tariffs generated from a changed tariff', async () => {
    await publishPricingChanged({
      pricingGroupId: 'pgr_1',
      tariffId: 'trf_1',
      action: 'tariff.updated',
    });
    expect(ocpiPushes()).toEqual([{ type: 'tariff', tariffId: 'trf_1', pricingGroupId: 'pgr_1' }]);
  });

  it('pushes every published tariff after a holiday change', async () => {
    await publishPricingChanged({ pricingGroupId: null, action: 'holiday.changed' });
    expect(ocpiPushes()).toEqual([{ type: 'tariff', tariffId: null, pricingGroupId: null }]);
  });

  it('does not push for changes that do not alter a published tariff', async () => {
    await publishPricingChanged({ pricingGroupId: 'pgr_1', action: 'group.created' });
    await publishPricingChanged({ pricingGroupId: 'pgr_1', action: 'assignment.changed' });
    expect(ocpiPushes()).toEqual([]);
  });

  it('does not push while roaming is disabled', async () => {
    mocks.isRoamingEnabled.mockResolvedValue(false);
    await publishPricingChanged({ pricingGroupId: 'pgr_1', action: 'group.updated' });
    expect(ocpiPushes()).toEqual([]);
    expect(mocks.publish).toHaveBeenCalledWith('csms_events', expect.any(String));
  });

  it('keeps going when a publish fails', async () => {
    mocks.publish.mockRejectedValue(new Error('redis down'));
    await expect(
      publishPricingChanged({ pricingGroupId: 'pgr_1', action: 'tariff.created' }),
    ).resolves.toBeUndefined();
  });
});
