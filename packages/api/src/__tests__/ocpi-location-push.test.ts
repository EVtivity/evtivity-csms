// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  isRoamingEnabled: vi.fn(),
  recordRemovedOcpiEvses: vi.fn(),
  evseRows: [] as Array<{ id: string }>,
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(mocks.evseRows),
  };
  return {
    db: { select: () => chain },
    evses: { id: {}, stationId: {} },
    isRoamingEnabled: mocks.isRoamingEnabled,
    recordRemovedOcpiEvses: mocks.recordRemovedOcpiEvses,
  };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: mocks.publish }) }));

const { lostLocationAudience, publishOcpiLocationPush, publishOcpiStationSiteMove } =
  await import('../lib/ocpi-location-push.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRoamingEnabled.mockResolvedValue(true);
  mocks.publish.mockResolvedValue(undefined);
  mocks.recordRemovedOcpiEvses.mockResolvedValue(undefined);
  mocks.evseRows = [{ id: 'evs_1' }];
});

describe('lostLocationAudience', () => {
  const before = { ocpiLocationId: 'LOC-1', partnerIds: ['opr_a', 'opr_b'] };

  it('returns every partner when the site is unpublished', () => {
    expect(lostLocationAudience(before, null)).toEqual(before);
  });

  it('returns the partners dropped from the audience', () => {
    expect(
      lostLocationAudience(before, { ocpiLocationId: 'LOC-1', partnerIds: ['opr_b'] }),
    ).toEqual({ ocpiLocationId: 'LOC-1', partnerIds: ['opr_a'] });
  });

  it('returns every earlier partner under the old id when the location id changed', () => {
    expect(
      lostLocationAudience(before, { ocpiLocationId: 'LOC-2', partnerIds: ['opr_a', 'opr_b'] }),
    ).toEqual(before);
  });

  it('returns null when nobody loses the location', () => {
    expect(lostLocationAudience(before, before)).toBeNull();
    expect(lostLocationAudience(null, before)).toBeNull();
  });
});

describe('publish helpers', () => {
  it('publishes a location push with the partners that lost it', async () => {
    await publishOcpiLocationPush('sit_1', { ocpiLocationId: 'LOC-1', partnerIds: ['opr_a'] });
    expect(mocks.publish).toHaveBeenCalledWith(
      'ocpi_push',
      JSON.stringify({
        type: 'location',
        siteId: 'sit_1',
        removed: { ocpiLocationId: 'LOC-1', partnerIds: ['opr_a'] },
      }),
    );
  });

  it('records a moved station EVSEs as removed from the old site and pushes both sites', async () => {
    await publishOcpiStationSiteMove('sta_1', 'sit_old', 'sit_new');
    expect(mocks.recordRemovedOcpiEvses).toHaveBeenCalledWith('sit_old', ['evs_1']);
    expect(mocks.publish.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      JSON.stringify({ type: 'location', siteId: 'sit_old' }),
      JSON.stringify({ type: 'location', siteId: 'sit_new' }),
    ]);
  });

  it('does nothing when the site did not change', async () => {
    await publishOcpiStationSiteMove('sta_1', 'sit_1', 'sit_1');
    expect(mocks.recordRemovedOcpiEvses).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('pushes only the new site for a station that had none', async () => {
    await publishOcpiStationSiteMove('sta_1', null, 'sit_new');
    expect(mocks.recordRemovedOcpiEvses).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing while roaming is off', async () => {
    mocks.isRoamingEnabled.mockResolvedValue(false);
    await publishOcpiLocationPush('sit_1', null);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('fails open when recording or publishing fails', async () => {
    mocks.recordRemovedOcpiEvses.mockRejectedValue(new Error('db down'));
    mocks.publish.mockRejectedValue(new Error('redis down'));
    const warn = vi.fn();
    await expect(
      publishOcpiStationSiteMove('sta_1', 'sit_old', 'sit_new', { warn } as never),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
