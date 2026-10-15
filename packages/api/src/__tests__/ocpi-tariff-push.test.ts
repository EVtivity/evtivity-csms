// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  isRoamingEnabled: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({ isRoamingEnabled: mocks.isRoamingEnabled }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: mocks.publish }) }));

const { publishOcpiTariffPush, publishOcpiTariffSettingChange } =
  await import('../lib/ocpi-tariff-push.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRoamingEnabled.mockResolvedValue(true);
  mocks.publish.mockResolvedValue(undefined);
});

function published(): Array<Record<string, unknown>> {
  return mocks.publish.mock.calls.map(
    (c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>,
  );
}

describe('publishOcpiTariffSettingChange', () => {
  it.each(['company.currency', 'company.taxBasis', 'idling.gracePeriodMinutes'])(
    'pushes every published tariff after a change of %s',
    async (key) => {
      await publishOcpiTariffSettingChange(key, 'a', 'b');
      expect(published()).toEqual([{ type: 'tariff', settingsChanged: true }]);
    },
  );

  it('pushes nothing for an unchanged value or another setting', async () => {
    await publishOcpiTariffSettingChange('company.currency', 'EUR', 'EUR');
    await publishOcpiTariffSettingChange('company.name', 'A', 'B');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('pushes after a deleted setting (back to the default)', async () => {
    await publishOcpiTariffSettingChange('idling.gracePeriodMinutes', 5, undefined);
    expect(published()).toEqual([{ type: 'tariff', settingsChanged: true }]);
  });
});

describe('publishOcpiTariffPush', () => {
  it('publishes nothing while roaming is off', async () => {
    mocks.isRoamingEnabled.mockResolvedValue(false);
    await publishOcpiTariffPush({ settingsChanged: true });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('fails open when the publish fails', async () => {
    mocks.publish.mockRejectedValue(new Error('redis down'));
    await expect(publishOcpiTariffPush({ tariffId: 'trf_1' })).resolves.toBeUndefined();
  });
});
