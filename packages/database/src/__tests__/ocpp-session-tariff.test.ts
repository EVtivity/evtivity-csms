// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { PubSubClient } from '@evtivity/lib';

const h = vi.hoisted(() => ({
  resolveStationTariff: vi.fn(),
  resolveGroupTariffs: vi.fn(),
  getPricingHolidays: vi.fn(),
  isSplitBillingEnabled: vi.fn(),
  getIdlingGracePeriodMinutes: vi.fn(),
}));

vi.mock('../lib/tariff-resolution.js', () => ({
  resolveStationTariff: h.resolveStationTariff,
  resolveGroupTariffs: h.resolveGroupTariffs,
  getPricingHolidays: h.getPricingHolidays,
}));
vi.mock('../lib/pricing-settings.js', () => ({ isSplitBillingEnabled: h.isSplitBillingEnabled }));
vi.mock('../lib/idling-setting.js', () => ({
  getIdlingGracePeriodMinutes: h.getIdlingGracePeriodMinutes,
}));
vi.mock('../lib/system-settings.js', () => ({
  getCompanyCurrency: () => Promise.resolve('EUR'),
  getCompanyTaxBasis: () => Promise.resolve('net'),
}));

const { buildStationOcppTariff, sendSessionTariffChange, stationTariffCapabilities } =
  await import('../lib/ocpp-session-tariff.js');

/** A tagged-template sql mock answering by the first matching query fragment. */
function makeSql(answers: Array<[string, Record<string, unknown>[]]> = []): {
  sql: postgres.Sql;
  texts: string[];
} {
  const texts: string[] = [];
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join('?');
    texts.push(text);
    const match = answers.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(match?.[1] ?? []);
  };
  return { sql: fn as unknown as postgres.Sql, texts };
}

const DEFAULT = {
  id: 'trf_default',
  name: 'Standard',
  pricePerKwh: '0.30',
  pricePerMinute: null,
  pricePerSession: null,
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: null,
  restrictions: null,
  priority: 0,
  isDefault: true,
};
const PEAK = {
  ...DEFAULT,
  id: 'trf_peak',
  name: 'Peak',
  pricePerKwh: '0.50',
  restrictions: { timeRange: { startTime: '17:00', endTime: '21:00' } },
  priority: 10,
  isDefault: false,
};
const RESOLVED = {
  ...DEFAULT,
  pricingGroup: { id: 'pgr_1', name: 'Members', source: 'driver' },
  timezone: 'America/Los_Angeles',
};

const caps = (rows: Array<[string, string]>): Array<[string, Record<string, unknown>[]]> => [
  [
    "component = 'TariffCostCtrlr'",
    rows.map(([variable, value]) => ({ variable, variable_instance: 'Tariff', value })),
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveStationTariff.mockResolvedValue(RESOLVED);
  h.resolveGroupTariffs.mockResolvedValue({ tariffs: [DEFAULT, PEAK], current: DEFAULT });
  h.getPricingHolidays.mockResolvedValue([]);
  h.isSplitBillingEnabled.mockResolvedValue(false);
  h.getIdlingGracePeriodMinutes.mockResolvedValue(5);
});

describe('stationTariffCapabilities', () => {
  it('reads Enabled, ConditionsSupported and MaxElements of TariffCostCtrlr', async () => {
    const { sql } = makeSql(
      caps([
        ['Enabled', 'true'],
        ['ConditionsSupported', 'false'],
        ['MaxElements', '4'],
      ]),
    );
    expect(await stationTariffCapabilities(sql, 'sta_1')).toEqual({
      localCost: true,
      conditions: false,
      maxElements: 4,
    });
  });

  it('treats an unreported station as no local cost, with conditions and no element limit', async () => {
    const { sql } = makeSql();
    expect(await stationTariffCapabilities(sql, 'sta_1')).toEqual({
      localCost: false,
      conditions: true,
      maxElements: null,
    });
  });
});

describe('buildStationOcppTariff', () => {
  it('sends the resolved tariff alone without split billing', async () => {
    const { sql } = makeSql();
    const tariff = await buildStationOcppTariff(sql, { stationUuid: 'sta_1', driverUuid: 'drv_1' });
    expect(tariff?.currency).toBe('EUR');
    expect(tariff?.energy?.prices).toEqual([{ priceKwh: 0.3 }]);
    expect(h.resolveGroupTariffs).not.toHaveBeenCalled();
  });

  it("adds the group's tariffs as conditions with split billing", async () => {
    h.isSplitBillingEnabled.mockResolvedValue(true);
    const { sql } = makeSql();
    const at = new Date('2026-10-09T19:00:00Z');
    const tariff = await buildStationOcppTariff(sql, {
      stationUuid: 'sta_1',
      driverUuid: 'drv_1',
      at,
    });
    expect(h.resolveGroupTariffs).toHaveBeenCalledWith(
      'pgr_1',
      { at, timezone: 'America/Los_Angeles' },
      sql,
    );
    expect(tariff?.energy?.prices).toEqual([
      { priceKwh: 0.5, conditions: { startTimeOfDay: '17:00', endTimeOfDay: '21:00' } },
      { priceKwh: 0.3 },
    ]);
  });

  it('is null when no tariff applies', async () => {
    h.resolveStationTariff.mockResolvedValue(null);
    const { sql } = makeSql();
    expect(await buildStationOcppTariff(sql, { stationUuid: 'sta_1', driverUuid: null })).toBe(
      null,
    );
  });
});

describe('sendSessionTariffChange', () => {
  const session = {
    transaction_id: 'tx-1',
    station_uuid: 'sta_1',
    driver_id: 'drv_1',
    station_tariff_id: 'evt-old',
    status: 'active',
    ocpp_id: 'CS-1',
    ocpp_protocol: 'ocpp2.1',
    is_online: true,
  };
  const publish = vi.fn().mockResolvedValue(undefined);
  const pubsub = { publish } as unknown as PubSubClient;
  const at = new Date('2026-10-09T19:00:00Z');

  it('publishes ChangeTransactionTariff to a local-cost station whose tariff differs', async () => {
    const { sql } = makeSql([
      ['FROM charging_sessions cs', [session]],
      ...caps([['Enabled', 'true']]),
    ]);
    expect(
      await sendSessionTariffChange(sql, pubsub, { sessionId: 'ses_1', at, energyWh: 2500 }),
    ).toBe('sent');
    expect(h.resolveStationTariff).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: 'drv_1', at, sessionEnergyKwh: 2.5 },
      sql,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(raw)).toMatchObject({
      stationId: 'CS-1',
      action: 'ChangeTransactionTariff',
      version: 'ocpp2.1',
      payload: { transactionId: 'tx-1', tariff: { currency: 'EUR' } },
    });
  });

  it('sends nothing when the station already has that tariff', async () => {
    const { sql } = makeSql([...caps([['Enabled', 'true']])]);
    const built = await buildStationOcppTariff(sql, {
      stationUuid: 'sta_1',
      driverUuid: 'drv_1',
      at,
    });
    const same = makeSql([
      ['FROM charging_sessions cs', [{ ...session, station_tariff_id: built?.tariffId }]],
      ...caps([['Enabled', 'true']]),
    ]);
    expect(
      await sendSessionTariffChange(same.sql, pubsub, { sessionId: 'ses_1', at, energyWh: 0 }),
    ).toBe('unchanged');
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ['without local cost', session, []],
    ['on OCPP 1.6', { ...session, ocpp_protocol: 'ocpp1.6' }, [['Enabled', 'true']]],
    ['offline', { ...session, is_online: false }, [['Enabled', 'true']]],
    ['ended', { ...session, status: 'completed' }, [['Enabled', 'true']]],
  ] as Array<[string, typeof session, Array<[string, string]>]>)(
    'skips a station %s',
    async (_name, row, capabilities) => {
      const { sql } = makeSql([['FROM charging_sessions cs', [row]], ...caps(capabilities)]);
      expect(
        await sendSessionTariffChange(sql, pubsub, { sessionId: 'ses_1', at, energyWh: 0 }),
      ).toBe('skipped');
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('fails open when the publish throws', async () => {
    publish.mockRejectedValueOnce(new Error('redis down'));
    const { sql } = makeSql([
      ['FROM charging_sessions cs', [session]],
      ...caps([['Enabled', 'true']]),
    ]);
    expect(
      await sendSessionTariffChange(sql, pubsub, { sessionId: 'ses_1', at, energyWh: 0 }),
    ).toBe('failed');
  });
});
