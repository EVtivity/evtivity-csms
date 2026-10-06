// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

// -- Hoisted mocks --

const {
  mockIsStationMessageEnabled,
  mockGetStationMessagePricingFormat,
  mockRenderStationMessage,
  mockResolveTariff,
  mockGetStationMessageLanguage,
  mockGetCompanyPriceDisplay,
  mockGetStationMessageBrandLine,
  mockPublish,
  mockSubscribe,
} = vi.hoisted(() => ({
  mockGetStationMessageBrandLine: vi.fn(),
  mockIsStationMessageEnabled: vi.fn(),
  mockGetStationMessagePricingFormat: vi.fn(),
  mockRenderStationMessage: vi.fn(),
  mockResolveTariff: vi.fn(),
  mockGetStationMessageLanguage: vi.fn(),
  mockGetCompanyPriceDisplay: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
}));

// -- Mocks --

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getSystemTimezone: vi.fn(() => Promise.resolve('America/New_York')),
  getCompanyPriceDisplay: mockGetCompanyPriceDisplay,
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  getStationMessageLanguage: mockGetStationMessageLanguage,
  getStationMessageBrandLine: mockGetStationMessageBrandLine,
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  client: vi.fn().mockResolvedValue([
    { key: 'company.name', value: 'EVtivity' },
    { key: 'company.supportPhone', value: '+1-555-0100' },
  ]),
  chargingStations: {
    id: 'id',
    stationId: 'stationId',
    siteId: 'siteId',
    isOnline: 'isOnline',
    ocppProtocol: 'ocppProtocol',
  },
  sites: { id: 'id', stationMessageLanguage: 'stationMessageLanguage', timezone: 'timezone' },
  evses: { id: 'id', stationId: 'stationId' },
  connectors: { evseId: 'evseId', status: 'status' },
  reservations: {
    stationId: 'stationId',
    status: 'status',
    expiresAt: 'expiresAt',
    driverId: 'driverId',
  },
  drivers: { id: 'id', firstName: 'firstName' },
  chargingSessions: {
    stationId: 'stationId',
    status: 'status',
    id: 'id',
    evseId: 'evseId',
    driverId: 'driverId',
    transactionId: 'transactionId',
    startedAt: 'startedAt',
    energyDeliveredWh: 'energyDeliveredWh',
    currentCostCents: 'currentCostCents',
    currency: 'currency',
    tariffIdleFeePricePerMinute: 'tariffIdleFeePricePerMinute',
    tariffTaxRate: 'tariffTaxRate',
    taxBasis: 'taxBasis',
  },
  meterValues: {
    sessionId: 'sessionId',
    measurand: 'measurand',
    value: 'value',
    unit: 'unit',
    timestamp: 'timestamp',
  },
  stationMessagePushes: {
    stationId: 'stationId',
    ocppMessageId: 'ocppMessageId',
    contentHash: 'contentHash',
    state: 'state',
    pushedAt: 'pushedAt',
  },
  isStationMessageEnabled: mockIsStationMessageEnabled,
  getStationMessagePricingFormat: mockGetStationMessagePricingFormat,
  resolveStationTariff: mockResolveTariff,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gt: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(() => ({})),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  renderStationMessage: mockRenderStationMessage,
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: mockSubscribe })),
}));

// -- Import under test (after mocks) --

import {
  pushAllStationMessages,
  pushStationMessageSlot,
  clearStationMessageSlot,
  pushTransactionMessage,
  clearAllTransactionMessages,
  pushAllMessagesToAllStations,
  requestStationMessageRepush,
  parseStationRefreshPayload,
  parseStationTransactionPayload,
  runStationRefresh,
  runStationTransaction,
  runStationRender,
  STATION_MESSAGE_SLOT_IDLE,
  STATION_MESSAGE_SLOT_CHARGING,
  STATION_MESSAGE_SLOT_SUSPENDED,
  STATION_MESSAGE_SLOT_DISCHARGING,
  STATION_MESSAGE_SLOT_FAULTED,
  STATION_MESSAGE_SLOT_UNAVAILABLE,
  type TransactionSessionRow,
} from '../station-message.service.js';
import { formatStationElapsed } from '@evtivity/lib';
import * as nodeCryptoModule from 'node:crypto';
import * as drizzleOrmModule from 'drizzle-orm';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

const STATION_OCPP_ID = 'CS-0001';
const INTERNAL_STATION_ID = 'sta_000000000001';

const STATION_ROW = {
  id: INTERNAL_STATION_ID,
  stationOcppId: STATION_OCPP_ID,
  siteId: 'sit_000000000001',
};

const TARIFF = {
  id: 'trf_1',
  name: 'Default',
  pricePerKwh: '0.30',
  pricePerMinute: '0.02',
  pricePerSession: null,
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: null,
  restrictions: null,
  priority: 0,
  isDefault: true,
};

describe('station-message.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    mockIsStationMessageEnabled.mockResolvedValue(true);
    mockGetStationMessagePricingFormat.mockResolvedValue('compact');
    mockResolveTariff.mockResolvedValue(TARIFF);
    mockGetStationMessageLanguage.mockResolvedValue('en');
    mockGetStationMessageBrandLine.mockResolvedValue('');
    mockGetCompanyPriceDisplay.mockResolvedValue('net');
    mockRenderStationMessage.mockImplementation((state: string) =>
      Promise.resolve(`rendered:${state}`),
    );
    mockPublish.mockResolvedValue(undefined);
  });

  describe('pushAllStationMessages', () => {
    it('returns early when stationMessage.enabled is false', async () => {
      mockIsStationMessageEnabled.mockResolvedValueOnce(false);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('pushes only the Idle screen to OCPP 1.6 stations, as a vendor DataTransfer', async () => {
      // 1) station lookup, 2) connector statuses, 3) idle existing push, 4) idle upsert
      setupDbResults([STATION_ROW], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp1.6', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledTimes(1);
      expect(mockRenderStationMessage).toHaveBeenCalledWith('available', expect.any(Object), 'en');
      expect(mockPublish).toHaveBeenCalledTimes(1);
      const published = JSON.parse(mockPublish.mock.calls[0]?.[1] as string) as {
        action: string;
        version: string;
        payload: { vendorId: string; messageId: string; data: string };
      };
      expect(published.action).toBe('DataTransfer');
      expect(published.version).toBe('ocpp1.6');
      expect(published.payload.vendorId).toBe('com.evtivity');
      expect(published.payload.messageId).toBe('PricingDisplay');
      expect(JSON.parse(published.payload.data)).toEqual({ pricing: 'rendered:available' });
    });

    it('skips protocols other than OCPP 1.6 and 2.x', async () => {
      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp1.5', mockLogger);

      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it("renders in the site's display language when the site sets one", async () => {
      setupDbResults([{ ...STATION_ROW, siteLanguage: 'de' }], [], [], [], [], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith('available', expect.any(Object), 'de');
      expect(mockRenderStationMessage).toHaveBeenCalledWith('faulted', expect.any(Object), 'de');
      expect(mockGetStationMessageLanguage).not.toHaveBeenCalled();
    });

    it('passes the brand line setting to the templates', async () => {
      mockGetStationMessageBrandLine.mockResolvedValue('ACME Charging');
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'available',
        expect.objectContaining({ brandLine: 'ACME Charging', companyName: 'EVtivity' }),
        'en',
      );
    });

    it('pushes 3 slots (idle/faulted/unavailable) when enabled with available connector', async () => {
      // DB calls in order:
      // 1) station lookup -> [STATION_ROW]
      // 2) connector status query (resolveIdleState) -> []
      // 3) idle slot existing push -> []
      // 4) idle slot insert -> []
      // 5) faulted slot existing push -> []
      // 6) faulted slot insert -> []
      // 7) unavailable slot existing push -> []
      // 8) unavailable slot insert -> []
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith('available', expect.any(Object), 'en');
      expect(mockRenderStationMessage).toHaveBeenCalledWith('faulted', expect.any(Object), 'en');
      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'unavailable',
        expect.any(Object),
        'en',
      );
      expect(mockPublish).toHaveBeenCalledTimes(3);
      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'available',
        expect.objectContaining({ pricingDisplay: '€0.30/kWh + €0.02/min' }),
        'en',
      );

      const publishedSlots = mockPublish.mock.calls.map((call) => {
        const body = JSON.parse(call[1] as string) as {
          payload: { message: { id: number; state: string } };
        };
        return body.payload.message;
      });
      const slotIds = publishedSlots.map((s) => s.id);
      expect(slotIds).toContain(STATION_MESSAGE_SLOT_IDLE);
      expect(slotIds).toContain(STATION_MESSAGE_SLOT_FAULTED);
      expect(slotIds).toContain(STATION_MESSAGE_SLOT_UNAVAILABLE);
    });

    it('shows gross prices with the tax note in the display language', async () => {
      mockGetStationMessageLanguage.mockResolvedValue('de');
      mockGetCompanyPriceDisplay.mockResolvedValue('gross');
      mockResolveTariff.mockResolvedValue({ ...TARIFF, taxRate: '0.19' });
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'available',
        expect.objectContaining({
          pricingDisplay: '0,357 €/kWh + 0,0238 €/Min.',
          energyPrice: '0,357 €',
          taxRatePercent: '19',
          pricesIncludeTax: true,
        }),
        'de',
      );
      expect(mockRenderStationMessage).toHaveBeenCalledWith('faulted', expect.any(Object), 'de');
      // The station screen shows the walk-up price: no driver.
      expect(mockResolveTariff).toHaveBeenCalledWith(
        { stationUuid: INTERNAL_STATION_ID, driverUuid: null },
        expect.anything(),
      );
    });

    it('skips dispatch when contentHash matches existing push (no-op)', async () => {
      // Pre-compute the hash for "rendered:available", "rendered:faulted", "rendered:unavailable"
      const crypto = nodeCryptoModule;
      const idleHash = crypto.createHash('sha256').update('rendered:available').digest('hex');
      const faultedHash = crypto.createHash('sha256').update('rendered:faulted').digest('hex');
      const unavailableHash = crypto
        .createHash('sha256')
        .update('rendered:unavailable')
        .digest('hex');

      setupDbResults(
        [STATION_ROW],
        [],
        [{ contentHash: idleHash }],
        [{ contentHash: faultedHash }],
        [{ contentHash: unavailableHash }],
      );

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('uses reserved template when connector is reserved with active reservation', async () => {
      const reservationRow = {
        expiresAt: new Date('2026-05-06T15:45:00Z'),
        driverFirstName: 'Alex',
      };

      setupDbResults(
        [STATION_ROW],
        [{ status: 'reserved' }],
        [reservationRow],
        [],
        [],
        [],
        [],
        [],
        [],
      );

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'reserved',
        expect.objectContaining({
          driverFirstName: 'Alex',
          reservationExpiresAt: expect.stringMatching(/^11:45\sAM$/),
        }),
        'en',
      );
    });

    it('shows the reservation end in the time zone of the site', async () => {
      const reservationRow = {
        expiresAt: new Date('2026-05-06T15:45:00Z'),
        driverFirstName: null,
        siteTimezone: 'Europe/Berlin',
      };

      setupDbResults(
        [STATION_ROW],
        [{ status: 'reserved' }],
        [reservationRow],
        [],
        [],
        [],
        [],
        [],
        [],
      );

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'reserved',
        expect.objectContaining({
          reservationExpiresAt: expect.stringMatching(/^5:45\sPM$/),
        }),
        'en',
      );
    });

    it('uses occupied template when connector is occupied without active session', async () => {
      setupDbResults([STATION_ROW], [{ status: 'occupied' }], [], [], [], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith('occupied', expect.any(Object), 'en');
    });
  });

  describe('pushStationMessageSlot', () => {
    it('publishes SetDisplayMessage for OCPP 2.1', async () => {
      await pushStationMessageSlot(STATION_OCPP_ID, 'ocpp2.1', 9000, 'Idle', 'Hello');

      expect(mockPublish).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
        action: string;
        payload: { message: { id: number; state: string; message: { content: string } } };
      };
      expect(body.action).toBe('SetDisplayMessage');
      expect(body.payload.message.id).toBe(9000);
      expect(body.payload.message.state).toBe('Idle');
      expect(body.payload.message.message.content).toBe('Hello');
    });

    it('falls back to DataTransfer for OCPP 1.6 idle slot only', async () => {
      await pushStationMessageSlot(STATION_OCPP_ID, 'ocpp1.6', 9000, 'Idle', 'Pricing');

      expect(mockPublish).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockPublish.mock.calls[0]![1] as string) as { action: string };
      expect(body.action).toBe('DataTransfer');
    });

    it('skips OCPP 1.6 for non-idle slots', async () => {
      await pushStationMessageSlot(STATION_OCPP_ID, 'ocpp1.6', 9004, 'Faulted', 'Fault');

      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('pushTransactionMessage', () => {
    function makeSession(overrides: Partial<TransactionSessionRow> = {}): TransactionSessionRow {
      return {
        id: 'ses_1',
        stationId: INTERNAL_STATION_ID,
        evseId: 'evs_1',
        driverId: 'drv_1',
        transactionId: 'tx-1',
        startedAt: new Date(Date.now() - 12 * 60_000),
        energyDeliveredWh: '12400',
        currentCostCents: 342,
        currency: 'USD',
        chargingState: null,
        tariffIdleFeePricePerMinute: '0.10',
        tariffTaxRate: null,
        taxBasis: 'net',
        ...overrides,
      };
    }

    it('skips OCPP 1.6 stations', async () => {
      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp1.6',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('skips when station messages are disabled', async () => {
      mockIsStationMessageEnabled.mockResolvedValueOnce(false);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('dispatches charging template into slot 9001 when chargingState is Charging', async () => {
      // DB calls in order:
      // 1) existing transaction-slot pushes -> []
      // 2) latest power meter value -> [{ value: '7000', unit: 'W' }]
      // 3) driver lookup -> [{ firstName: 'Alex' }]
      // 4) station_message_pushes upsert (insert chain)
      setupDbResults([], [{ value: '7000', unit: 'W' }], [{ firstName: 'Alex' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({
          energyKwh: '12.4',
          powerKw: '7.0',
          driverFirstName: 'Alex',
        }),
        'en',
      );
      expect(mockPublish).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
        action: string;
        payload: { message: { id: number; state: string } };
      };
      expect(body.action).toBe('SetDisplayMessage');
      expect(body.payload.message.id).toBe(STATION_MESSAGE_SLOT_CHARGING);
      expect(body.payload.message.state).toBe('Charging');
    });

    it('dispatches suspended template (slot 9002) and clears 9003 on SuspendedEV', async () => {
      // existing pushes include slot 9003 (Discharging) -> must be cleared
      setupDbResults(
        [
          {
            ocppMessageId: STATION_MESSAGE_SLOT_DISCHARGING,
            contentHash: 'old-hash',
          },
        ],
        [],
        [],
        [],
      );

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'SuspendedEV' }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'suspended',
        expect.objectContaining({ idleFeeRate: expect.stringContaining('/min') }),
        'en',
      );

      const actions = mockPublish.mock.calls.map((c) => {
        const body = JSON.parse(c[1] as string) as {
          action: string;
          payload: { message?: { id: number; state: string }; id?: number };
        };
        return body;
      });

      const setCall = actions.find((a) => a.action === 'SetDisplayMessage');
      expect(setCall?.payload.message?.id).toBe(STATION_MESSAGE_SLOT_SUSPENDED);
      expect(setCall?.payload.message?.state).toBe('Suspended');

      const clearCall = actions.find(
        (a) =>
          a.action === 'ClearDisplayMessage' && a.payload.id === STATION_MESSAGE_SLOT_DISCHARGING,
      );
      expect(clearCall).toBeDefined();
    });

    it('dispatches discharging template (slot 9003) and clears 9002 on Discharging', async () => {
      setupDbResults(
        [
          {
            ocppMessageId: STATION_MESSAGE_SLOT_SUSPENDED,
            contentHash: 'old-hash',
          },
        ],
        [],
        [],
        [],
      );

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Discharging' }),
        mockLogger,
      );

      const actions = mockPublish.mock.calls.map((c) => {
        const body = JSON.parse(c[1] as string) as {
          action: string;
          payload: { message?: { id: number; state: string }; id?: number };
        };
        return body;
      });

      const setCall = actions.find((a) => a.action === 'SetDisplayMessage');
      expect(setCall?.payload.message?.id).toBe(STATION_MESSAGE_SLOT_DISCHARGING);
      expect(setCall?.payload.message?.state).toBe('Discharging');

      const clearCall = actions.find(
        (a) =>
          a.action === 'ClearDisplayMessage' && a.payload.id === STATION_MESSAGE_SLOT_SUSPENDED,
      );
      expect(clearCall).toBeDefined();
    });

    it('clears slot 9002 when transitioning Charging-from-Suspended', async () => {
      // Existing rows: 9001 (Charging) and 9002 (Suspended).
      // chargingState is now Charging -> we should refresh 9001 and clear 9002.
      setupDbResults(
        [
          { ocppMessageId: STATION_MESSAGE_SLOT_CHARGING, contentHash: 'old-charging' },
          { ocppMessageId: STATION_MESSAGE_SLOT_SUSPENDED, contentHash: 'old-suspended' },
        ],
        [],
        [],
        [],
      );

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      const clearCall = mockPublish.mock.calls.find((c) => {
        const body = JSON.parse(c[1] as string) as { action: string; payload: { id?: number } };
        return (
          body.action === 'ClearDisplayMessage' &&
          body.payload.id === STATION_MESSAGE_SLOT_SUSPENDED
        );
      });
      expect(clearCall).toBeDefined();
    });

    it('clears 9001/9002/9003 on session ended', async () => {
      // existing pushes returned for clearAllTransactionMessages
      setupDbResults([
        { ocppMessageId: STATION_MESSAGE_SLOT_CHARGING },
        { ocppMessageId: STATION_MESSAGE_SLOT_SUSPENDED },
        { ocppMessageId: STATION_MESSAGE_SLOT_DISCHARGING },
      ]);

      await clearAllTransactionMessages(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        mockLogger,
      );

      const cleared = mockPublish.mock.calls
        .map((c) => JSON.parse(c[1] as string) as { action: string; payload: { id?: number } })
        .filter((b) => b.action === 'ClearDisplayMessage')
        .map((b) => b.payload.id);

      expect(cleared).toEqual(
        expect.arrayContaining([
          STATION_MESSAGE_SLOT_CHARGING,
          STATION_MESSAGE_SLOT_SUSPENDED,
          STATION_MESSAGE_SLOT_DISCHARGING,
        ]),
      );
    });

    it('does not push when chargingState is Idle/EVConnected and no tracked slots', async () => {
      setupDbResults([]);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Idle' }),
        mockLogger,
      );

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('clears a stale transaction slot when chargingState becomes Idle', async () => {
      // chargingState Idle with an existing 9001 row -> clear 9001 + delete row.
      setupDbResults([{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING, contentHash: 'h' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Idle' }),
        mockLogger,
      );

      const clearCall = mockPublish.mock.calls.find((c) => {
        const body = JSON.parse(c[1] as string) as { action: string; payload: { id?: number } };
        return (
          body.action === 'ClearDisplayMessage' && body.payload.id === STATION_MESSAGE_SLOT_CHARGING
        );
      });
      expect(clearCall).toBeDefined();
    });

    it('logs a warning when clearing a stale slot fails on Idle transition', async () => {
      setupDbResults([{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING, contentHash: 'h' }]);
      // The ClearDisplayMessage publish rejects.
      mockPublish.mockRejectedValueOnce(new Error('clear failed'));

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Idle' }),
        mockLogger,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ slot: STATION_MESSAGE_SLOT_CHARGING }),
        'Failed to clear stale transaction message slot',
      );
    });

    it('skips dispatch when the transaction content hash matches the existing push', async () => {
      const hash = nodeCryptoModule.createHash('sha256').update('rendered:charging').digest('hex');
      setupDbResults(
        [{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING, contentHash: hash }],
        [{ value: '7000', unit: 'W' }],
        [{ firstName: 'Alex' }],
      );

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      const setCall = mockPublish.mock.calls.find((c) => {
        const body = JSON.parse(c[1] as string) as { action: string };
        return body.action === 'SetDisplayMessage';
      });
      expect(setCall).toBeUndefined();
    });

    it('returns without publishing when the transaction template renders empty', async () => {
      mockRenderStationMessage.mockResolvedValueOnce('');
      setupDbResults([], [], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('logs a warning when the transaction template render throws', async () => {
      mockRenderStationMessage.mockRejectedValueOnce(new Error('template broken'));
      setupDbResults([], [], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateState: 'charging' }),
        'Failed to render transaction station message',
      );
    });

    it('logs a warning when the transaction dispatch publish throws', async () => {
      setupDbResults([], [{ value: '7000', unit: 'W' }], [{ firstName: 'Alex' }], []);
      mockPublish.mockRejectedValueOnce(new Error('publish failed'));

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ chargingState: 'Charging' }),
        mockLogger,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ slot: STATION_MESSAGE_SLOT_CHARGING }),
        'Failed to dispatch transaction station message',
      );
    });
  });

  describe('pushAllStationMessages edge cases', () => {
    it('returns early for a null ocppProtocol', async () => {
      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, null, mockLogger);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns when the station row is missing', async () => {
      setupDbResults([]); // station lookup empty

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('logs a warning when rendering throws', async () => {
      mockRenderStationMessage.mockReset();
      mockRenderStationMessage.mockRejectedValue(new Error('render broke'));
      setupDbResults([STATION_ROW], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: STATION_OCPP_ID }),
        'Failed to push station messages',
      );
    });

    it('renders an empty pricing display when no tariff resolves', async () => {
      mockResolveTariff.mockResolvedValueOnce(null);
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'available',
        expect.objectContaining({ pricingDisplay: '', taxRatePercent: '' }),
        'en',
      );
    });

    it('does not publish when the rendered content is empty (dispatchAndUpsert no-op)', async () => {
      mockRenderStationMessage.mockReset();
      mockRenderStationMessage.mockResolvedValue('');
      setupDbResults([STATION_ROW], []);

      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, 'ocpp2.1', mockLogger);

      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('clearStationMessageSlot', () => {
    it('publishes ClearDisplayMessage for OCPP 2.1', async () => {
      await clearStationMessageSlot(STATION_OCPP_ID, 'ocpp2.1', 9002);

      expect(mockPublish).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockPublish.mock.calls[0]![1] as string) as {
        action: string;
        payload: { id: number };
      };
      expect(body.action).toBe('ClearDisplayMessage');
      expect(body.payload.id).toBe(9002);
    });

    it('is a no-op for OCPP 1.6', async () => {
      await clearStationMessageSlot(STATION_OCPP_ID, 'ocpp1.6', 9002);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('is a no-op for a null protocol', async () => {
      await clearStationMessageSlot(STATION_OCPP_ID, null, 9002);
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('clearAllTransactionMessages edge cases', () => {
    it('returns early for OCPP 1.6', async () => {
      await clearAllTransactionMessages(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp1.6',
        mockLogger,
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('logs a warning when a clear fails', async () => {
      setupDbResults([{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING }]);
      mockPublish.mockRejectedValueOnce(new Error('clear boom'));

      await clearAllTransactionMessages(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        mockLogger,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ slot: STATION_MESSAGE_SLOT_CHARGING }),
        'Failed to clear transaction message slot on session end',
      );
    });
  });

  describe('transaction message formatting branches', () => {
    function makeSession(overrides: Partial<TransactionSessionRow> = {}): TransactionSessionRow {
      return {
        id: 'ses_1',
        stationId: INTERNAL_STATION_ID,
        evseId: 'evs_1',
        driverId: null,
        transactionId: 'tx-1',
        startedAt: null,
        energyDeliveredWh: null,
        currentCostCents: null,
        currency: 'USD',
        chargingState: 'Charging',
        tariffIdleFeePricePerMinute: null,
        tariffTaxRate: null,
        taxBasis: 'net',
        ...overrides,
      };
    }

    it('handles null startedAt, null energy, null cost, null power, no driver', async () => {
      // existing pushes [], power meter [] (empty -> ''), no driver lookup (driverId null)
      setupDbResults([], [], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession(),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ energyKwh: '0.0', powerKw: '', elapsedFormatted: '' }),
        'en',
      );
    });

    it("renders the transaction screen in the site's display language", async () => {
      // 1) existing pushes, 2) power, 3) site language (no driver), 4) upsert
      setupDbResults([], [{ value: '7', unit: 'kW' }], [{ language: 'de' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ startedAt: new Date(Date.now() - 95 * 60_000), driverId: null }),
        mockLogger,
      );

      // The German unit names come from the runtime's CLDR data and change between
      // Node releases, so compare with the formatter rather than a fixed string.
      const germanElapsed = formatStationElapsed(new Date(0), 'de', 95 * 60_000);
      expect(germanElapsed).not.toBe('1h 35m');
      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ elapsedFormatted: germanElapsed, powerKw: '7,0' }),
        'de',
      );
    });

    it('formats elapsed time over an hour', async () => {
      setupDbResults([], [{ value: '7', unit: 'kW' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ startedAt: new Date(Date.now() - 95 * 60_000), driverId: null }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ elapsedFormatted: '1h 35m', powerKw: '7.0' }),
        'en',
      );
    });

    it('ignores a future startedAt and a non-numeric power value', async () => {
      setupDbResults([], [{ value: 'not-a-number', unit: 'W' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ startedAt: new Date(Date.now() + 60_000) }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ elapsedFormatted: '', powerKw: '' }),
        'en',
      );
    });

    it('formats cost and idle-fee rate with a valid currency', async () => {
      setupDbResults([], [{ value: '7000', unit: 'W' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({
          currentCostCents: 500,
          currency: 'USD',
          tariffIdleFeePricePerMinute: '0.15',
        }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({
          costFormatted: '$5.00',
          idleFeeRate: expect.stringContaining('/min'),
        }),
        'en',
      );
    });

    it('shows the idle fee gross and numbers in the display language', async () => {
      mockGetStationMessageLanguage.mockResolvedValue('de');
      mockGetCompanyPriceDisplay.mockResolvedValue('gross');
      setupDbResults([], [{ value: '7000', unit: 'W' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({
          chargingState: 'SuspendedEV',
          energyDeliveredWh: '12400',
          currentCostCents: 500,
          currency: 'EUR',
          tariffIdleFeePricePerMinute: '0.10',
          tariffTaxRate: '0.19',
          taxBasis: 'net',
        }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'suspended',
        expect.objectContaining({
          costFormatted: '5,00 €',
          idleFeeRate: '0,119 €/Min.',
          energyKwh: '12,4',
          powerKw: '7,0',
          taxRatePercent: '19',
          pricesIncludeTax: true,
        }),
        'de',
      );
    });

    it('falls back gracefully when the currency code is invalid', async () => {
      setupDbResults([], [], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({
          currentCostCents: 500,
          currency: 'NOTACURRENCY',
          tariffIdleFeePricePerMinute: '0.15',
        }),
        mockLogger,
      );

      const ctx = mockRenderStationMessage.mock.calls[0]![1] as Record<string, string>;
      expect(ctx['costFormatted']).toBe('NOTACURRENCY 5.00');
      expect(ctx['idleFeeRate']).toBe('NOTACURRENCY 0.15/min');
    });

    it('omits the idle-fee rate when the rate is zero or negative', async () => {
      setupDbResults([], [], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ tariffIdleFeePricePerMinute: '0' }),
        mockLogger,
      );

      const ctx = mockRenderStationMessage.mock.calls[0]![1] as Record<string, unknown>;
      expect(ctx['idleFeeRate']).toBeUndefined();
    });

    it('treats a numeric power value already in kW unit as-is', async () => {
      setupDbResults([], [{ value: '11.2', unit: 'kW' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ driverId: 'drv_1' }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ powerKw: '11.2' }),
        'en',
      );
    });

    it('includes the driver first name when present', async () => {
      setupDbResults([], [], [{ firstName: 'Sam' }]);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ driverId: 'drv_1' }),
        mockLogger,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ driverFirstName: 'Sam' }),
        'en',
      );
    });
  });

  describe('runStationRender', () => {
    it('runs renders for one station one after the other', async () => {
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const first = runStationRender('sta_q', async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first:end');
      });
      const second = runStationRender('sta_q', async () => {
        order.push('second');
        await Promise.resolve();
      });
      const other = runStationRender('sta_other', async () => {
        order.push('other');
        await Promise.resolve();
      });

      await other;
      expect(order).toEqual(['first:start', 'other']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'other', 'first:end', 'second']);
    });

    it('runs the next render after a failed one', async () => {
      const failed = runStationRender('sta_fail', () => Promise.reject(new Error('boom')));
      const next = vi.fn(() => Promise.resolve());
      const after = runStationRender('sta_fail', next);

      await expect(failed).rejects.toThrow('boom');
      await after;
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseStationRefreshPayload', () => {
    it('accepts a complete payload', () => {
      expect(
        parseStationRefreshPayload(
          JSON.stringify({
            stationOcppId: STATION_OCPP_ID,
            internalStationId: INTERNAL_STATION_ID,
            ocppProtocol: 'ocpp1.6',
          }),
        ),
      ).toEqual({
        stationOcppId: STATION_OCPP_ID,
        internalStationId: INTERNAL_STATION_ID,
        ocppProtocol: 'ocpp1.6',
      });
    });

    it('rejects missing fields and malformed JSON', () => {
      expect(parseStationRefreshPayload(JSON.stringify({ stationOcppId: 'CS-1' }))).toBeNull();
      expect(parseStationRefreshPayload('{not json')).toBeNull();
      expect(parseStationRefreshPayload('null')).toBeNull();
    });
  });

  describe('runStationRefresh', () => {
    it('pushes all messages for the station through the render runner', async () => {
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);
      const render = vi.fn((_id: string, fn: () => Promise<void>) => fn());

      await runStationRefresh(
        {
          stationOcppId: STATION_OCPP_ID,
          internalStationId: INTERNAL_STATION_ID,
          ocppProtocol: 'ocpp2.1',
        },
        mockLogger,
        render,
      );

      expect(render).toHaveBeenCalledWith(INTERNAL_STATION_ID, expect.any(Function));
      expect(mockRenderStationMessage).toHaveBeenCalledWith('available', expect.any(Object), 'en');
    });
  });

  describe('parseStationTransactionPayload', () => {
    const base = {
      sessionId: 'ses_1',
      internalStationId: INTERNAL_STATION_ID,
      stationOcppId: STATION_OCPP_ID,
      ocppProtocol: 'ocpp2.1',
    };

    it('accepts a payload with or without a chargingState', () => {
      expect(
        parseStationTransactionPayload(
          JSON.stringify({ ...base, eventType: 'updated', chargingState: 'Charging' }),
        ),
      ).toEqual({ ...base, eventType: 'updated', chargingState: 'Charging' });
      expect(
        parseStationTransactionPayload(JSON.stringify({ ...base, eventType: 'ended' })),
      ).toEqual({ ...base, eventType: 'ended', chargingState: null });
    });

    it('rejects missing fields, an unknown event type, and malformed JSON', () => {
      expect(parseStationTransactionPayload(JSON.stringify({ sessionId: 'ses_1' }))).toBeNull();
      expect(
        parseStationTransactionPayload(JSON.stringify({ ...base, eventType: 'paused' })),
      ).toBeNull();
      expect(parseStationTransactionPayload('not-json')).toBeNull();
    });
  });

  describe('runStationTransaction', () => {
    const SESSION_DB_ROW = {
      id: 'ses_1',
      stationId: INTERNAL_STATION_ID,
      evseId: 'evs_1',
      driverId: null,
      transactionId: 'tx-1',
      startedAt: new Date(Date.now() - 5 * 60_000),
      energyDeliveredWh: '1000',
      currentCostCents: 100,
      currency: 'USD',
      tariffIdleFeePricePerMinute: null,
      tariffTaxRate: null,
      taxBasis: 'net',
      status: 'active',
    };

    const job = {
      sessionId: 'ses_1',
      internalStationId: INTERNAL_STATION_ID,
      stationOcppId: STATION_OCPP_ID,
      ocppProtocol: 'ocpp2.1',
    };

    function clearedSlots(): boolean {
      return mockPublish.mock.calls.some((c) => {
        const body = JSON.parse(c[1] as string) as { action: string };
        return body.action === 'ClearDisplayMessage';
      });
    }

    it('clears all transaction slots on an ended event', async () => {
      setupDbResults([{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING }]);
      await runStationTransaction({ ...job, eventType: 'ended' }, mockLogger);
      expect(clearedSlots()).toBe(true);
    });

    it('clears the slots instead of rendering when the session is no longer active', async () => {
      // 1) session row (completed), 2) existing transaction pushes
      setupDbResults(
        [{ ...SESSION_DB_ROW, status: 'completed', chargingState: 'Charging' }],
        [{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING }],
      );
      await runStationTransaction(
        { ...job, eventType: 'updated', chargingState: 'Charging' },
        mockLogger,
      );
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
      expect(clearedSlots()).toBe(true);
    });

    it('returns when the session row is not found', async () => {
      setupDbResults([]);
      await runStationTransaction({ ...job, eventType: 'updated' }, mockLogger);
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('loads the session and pushes a transaction message on an updated event', async () => {
      // 1) loadTransactionSessionById, then pushTransactionMessage: existing pushes, power, site language, insert
      setupDbResults([SESSION_DB_ROW], [], [], [], []);
      await runStationTransaction(
        { ...job, eventType: 'updated', chargingState: 'Charging' },
        mockLogger,
      );
      expect(mockRenderStationMessage).toHaveBeenCalledWith('charging', expect.any(Object), 'en');
    });

    it.each([
      ['SuspendedEV', 'suspended'],
      ['Charging', 'charging'],
      ['Discharging', 'discharging'],
    ])(
      'keeps the last reported state (%s) when the event has no chargingState',
      async (chargingState, templateState) => {
        setupDbResults([{ ...SESSION_DB_ROW, chargingState }], [], [], [], []);
        await runStationTransaction(
          { ...job, eventType: 'updated', chargingState: null },
          mockLogger,
        );
        expect(mockRenderStationMessage).toHaveBeenCalledWith(
          templateState,
          expect.any(Object),
          'en',
        );
      },
    );

    it('lets the chargingState in the event win over the stored state', async () => {
      setupDbResults([{ ...SESSION_DB_ROW, chargingState: 'Charging' }], [], [], [], []);
      await runStationTransaction(
        { ...job, eventType: 'updated', chargingState: 'SuspendedEVSE' },
        mockLogger,
      );
      expect(mockRenderStationMessage).toHaveBeenCalledWith('suspended', expect.any(Object), 'en');
    });
  });

  describe('pushAllMessagesToAllStations', () => {
    it('narrows the stations to a station, a site, or a pricing group', async () => {
      const drizzle = drizzleOrmModule;
      const eqMock = vi.mocked(drizzle.eq);
      const sqlMock = vi.mocked(drizzle.sql);

      setupDbResults([]);
      await pushAllMessagesToAllStations(mockLogger, { stationId: 'sta_9' });
      expect(eqMock).toHaveBeenCalledWith('id', 'sta_9');

      setupDbResults([]);
      await pushAllMessagesToAllStations(mockLogger, { siteId: 'sit_9' });
      expect(eqMock).toHaveBeenCalledWith('siteId', 'sit_9');

      sqlMock.mockClear();
      setupDbResults([]);
      await pushAllMessagesToAllStations(mockLogger, { pricingGroupId: 'pg_9' });
      const values = sqlMock.mock.calls.flatMap((c) => c.slice(1));
      expect(values).toContain('pg_9');
    });

    it('runs each station through the given render runner', async () => {
      setupDbResults(
        [{ id: INTERNAL_STATION_ID, stationOcppId: STATION_OCPP_ID, ocppProtocol: 'ocpp2.1' }],
        [STATION_ROW],
      );
      const render = vi.fn((_id: string, fn: () => Promise<void>) => fn());
      await pushAllMessagesToAllStations(mockLogger, {}, render);
      expect(render).toHaveBeenCalledWith(INTERNAL_STATION_ID, expect.any(Function));
    });

    it('pushes to every online OCPP 2.1 station and logs the count', async () => {
      // 1) online stations list
      // then pushAllStationMessages runs its own queries per station (the 1.6
      // station renders the Idle slot only).
      setupDbResults(
        [
          { id: INTERNAL_STATION_ID, stationOcppId: STATION_OCPP_ID, ocppProtocol: 'ocpp2.1' },
          { id: 'sta_2', stationOcppId: 'CS-0002', ocppProtocol: 'ocpp1.6' },
        ],
        [STATION_ROW],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      );

      await pushAllMessagesToAllStations(mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ pushed: 2 }),
        'Station messages pushed to stations',
      );
    });

    it('continues and warns when one station push throws', async () => {
      mockIsStationMessageEnabled.mockReset();
      // First station: enabled check throws -> caught in the per-station try/catch.
      mockIsStationMessageEnabled.mockRejectedValueOnce(new Error('settings down'));
      mockIsStationMessageEnabled.mockResolvedValue(true);

      setupDbResults(
        [
          { id: 'sta_a', stationOcppId: 'CS-A', ocppProtocol: 'ocpp2.1' },
          { id: 'sta_b', stationOcppId: 'CS-B', ocppProtocol: 'ocpp1.6' },
        ],
        // sta_b (1.6) finds no station row and returns.
      );

      await pushAllMessagesToAllStations(mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: 'CS-A' }),
        'Failed to push station messages to station',
      );
    });

    it('does not log when there are no online stations', async () => {
      setupDbResults([]);

      await pushAllMessagesToAllStations(mockLogger);

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Station messages pushed to stations',
      );
    });
  });
});

describe('requestStationMessageRepush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
  });

  it('asks every process to drop its caches, then the worker to re-render', async () => {
    await requestStationMessageRepush(mockLogger, { siteId: 'sit_1' });

    expect(mockPublish).toHaveBeenNthCalledWith(
      1,
      'cache_invalidate',
      JSON.stringify({ kind: 'station_message' }),
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      2,
      'station_message_repush',
      JSON.stringify({ siteId: 'sit_1' }),
    );
  });

  it('logs a warning and does not throw when the publish fails', async () => {
    mockPublish.mockRejectedValueOnce(new Error('redis down'));

    await expect(requestStationMessageRepush(mockLogger as never)).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Station message repush request failed',
    );
  });
});
