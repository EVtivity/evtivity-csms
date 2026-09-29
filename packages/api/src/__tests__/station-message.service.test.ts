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
  mockFormatPricingDisplay,
  mockPublish,
  mockSubscribe,
} = vi.hoisted(() => ({
  mockIsStationMessageEnabled: vi.fn(),
  mockGetStationMessagePricingFormat: vi.fn(),
  mockRenderStationMessage: vi.fn(),
  mockResolveTariff: vi.fn(),
  mockFormatPricingDisplay: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
}));

// -- Mocks --

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
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
  formatCurrencyAmount: (await importOriginal<typeof import('@evtivity/lib')>())
    .formatCurrencyAmount,
  formatPricingDisplay: mockFormatPricingDisplay,
  renderStationMessage: mockRenderStationMessage,
}));

vi.mock('../services/tariff.service.js', () => ({
  resolveTariff: mockResolveTariff,
}));

vi.mock('../lib/pubsub.js', () => ({
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
  startStationMessageRefreshListener,
  startStationMessageTransactionListener,
  STATION_MESSAGE_SLOT_IDLE,
  STATION_MESSAGE_SLOT_CHARGING,
  STATION_MESSAGE_SLOT_SUSPENDED,
  STATION_MESSAGE_SLOT_DISCHARGING,
  STATION_MESSAGE_SLOT_FAULTED,
  STATION_MESSAGE_SLOT_UNAVAILABLE,
  type TransactionSessionRow,
} from '../services/station-message.service.js';

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
    mockFormatPricingDisplay.mockReturnValue('$0.30/kWh + $0.02/min');
    mockRenderStationMessage.mockImplementation((state: string) =>
      Promise.resolve(`rendered:${state}`),
    );
    mockPublish.mockResolvedValue(undefined);
  });

  describe('pushAllStationMessages', () => {
    it('returns early when stationMessage.enabled is false', async () => {
      mockIsStationMessageEnabled.mockResolvedValueOnce(false);

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('skips OCPP 1.6 stations', async () => {
      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp1.6',
        mockLogger as never,
      );

      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
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

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith('available', expect.any(Object));
      expect(mockRenderStationMessage).toHaveBeenCalledWith('faulted', expect.any(Object));
      expect(mockRenderStationMessage).toHaveBeenCalledWith('unavailable', expect.any(Object));
      expect(mockPublish).toHaveBeenCalledTimes(3);
      expect(mockFormatPricingDisplay).toHaveBeenCalledWith(TARIFF, 'compact', 'EUR');

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

    it('skips dispatch when contentHash matches existing push (no-op)', async () => {
      // Pre-compute the hash for "rendered:available", "rendered:faulted", "rendered:unavailable"
      const crypto = await import('node:crypto');
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

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

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

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'reserved',
        expect.objectContaining({
          driverFirstName: 'Alex',
          reservationExpiresAt: expect.any(String),
        }),
      );
    });

    it('uses occupied template when connector is occupied without active session', async () => {
      setupDbResults([STATION_ROW], [{ status: 'occupied' }], [], [], [], [], [], []);

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith('occupied', expect.any(Object));
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
        ...overrides,
      };
    }

    it('skips OCPP 1.6 stations', async () => {
      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp1.6',
        makeSession({ chargingState: 'Charging' }),
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({
          energyKwh: '12.4',
          powerKw: '7.0',
          driverFirstName: 'Alex',
        }),
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
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'suspended',
        expect.objectContaining({ idleFeeRate: expect.stringContaining('/min') }),
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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ slot: STATION_MESSAGE_SLOT_CHARGING }),
        'Failed to clear stale transaction message slot',
      );
    });

    it('skips dispatch when the transaction content hash matches the existing push', async () => {
      const hash = (await import('node:crypto'))
        .createHash('sha256')
        .update('rendered:charging')
        .digest('hex');
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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ slot: STATION_MESSAGE_SLOT_CHARGING }),
        'Failed to dispatch transaction station message',
      );
    });
  });

  describe('pushAllStationMessages edge cases', () => {
    it('returns early for a null ocppProtocol', async () => {
      await pushAllStationMessages(STATION_OCPP_ID, INTERNAL_STATION_ID, null, mockLogger as never);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns when the station row is missing', async () => {
      setupDbResults([]); // station lookup empty

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('logs a warning when rendering throws', async () => {
      mockRenderStationMessage.mockReset();
      mockRenderStationMessage.mockRejectedValue(new Error('render broke'));
      setupDbResults([STATION_ROW], []);

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: STATION_OCPP_ID }),
        'Failed to push station messages',
      );
    });

    it('renders an empty pricing display when no tariff resolves', async () => {
      mockResolveTariff.mockResolvedValueOnce(null);
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

      expect(mockFormatPricingDisplay).not.toHaveBeenCalled();
      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'available',
        expect.objectContaining({ pricingDisplay: '' }),
      );
    });

    it('does not publish when the rendered content is empty (dispatchAndUpsert no-op)', async () => {
      mockRenderStationMessage.mockReset();
      mockRenderStationMessage.mockResolvedValue('');
      setupDbResults([STATION_ROW], []);

      await pushAllStationMessages(
        STATION_OCPP_ID,
        INTERNAL_STATION_ID,
        'ocpp2.1',
        mockLogger as never,
      );

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
        mockLogger as never,
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
        mockLogger as never,
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
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ energyKwh: '0.0', powerKw: '', elapsedFormatted: '' }),
      );
    });

    it('formats elapsed time over an hour', async () => {
      setupDbResults([], [{ value: '7', unit: 'kW' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ startedAt: new Date(Date.now() - 95 * 60_000), driverId: null }),
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ elapsedFormatted: '1h 35m', powerKw: '7.0' }),
      );
    });

    it('ignores a future startedAt and a non-numeric power value', async () => {
      setupDbResults([], [{ value: 'not-a-number', unit: 'W' }], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ startedAt: new Date(Date.now() + 60_000) }),
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ elapsedFormatted: '', powerKw: '' }),
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
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({
          costFormatted: '$5.00',
          idleFeeRate: expect.stringContaining('/min'),
        }),
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
        mockLogger as never,
      );

      const ctx = mockRenderStationMessage.mock.calls[0]![1] as Record<string, string>;
      expect(ctx['costFormatted']).toBe('NOTACURRENCY 5.00');
      expect(ctx['idleFeeRate']).toBe('0.15 NOTACURRENCY/min');
    });

    it('omits the idle-fee rate when the rate is zero or negative', async () => {
      setupDbResults([], [], []);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ tariffIdleFeePricePerMinute: '0' }),
        mockLogger as never,
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
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ powerKw: '11.2' }),
      );
    });

    it('includes the driver first name when present', async () => {
      setupDbResults([], [], [{ firstName: 'Sam' }]);

      await pushTransactionMessage(
        INTERNAL_STATION_ID,
        STATION_OCPP_ID,
        'ocpp2.1',
        makeSession({ driverId: 'drv_1' }),
        mockLogger as never,
      );

      expect(mockRenderStationMessage).toHaveBeenCalledWith(
        'charging',
        expect.objectContaining({ driverFirstName: 'Sam' }),
      );
    });
  });

  describe('startStationMessageRefreshListener', () => {
    async function getHandler() {
      await startStationMessageRefreshListener(mockLogger as never);
      const call = mockSubscribe.mock.calls.find((c) => c[0] === 'station_message_refresh');
      return call?.[1] as (raw: string) => void;
    }

    it('subscribes to the refresh channel', async () => {
      await startStationMessageRefreshListener(mockLogger as never);
      expect(mockSubscribe).toHaveBeenCalledWith('station_message_refresh', expect.any(Function));
    });

    it('ignores payloads missing required fields', async () => {
      const handler = await getHandler();
      handler(JSON.stringify({ stationOcppId: 'CS-1' })); // missing other fields
      await new Promise((r) => setTimeout(r, 10));
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('pushes all messages for a valid payload', async () => {
      setupDbResults([STATION_ROW], [], [], [], [], [], [], []);
      const handler = await getHandler();
      handler(
        JSON.stringify({
          stationOcppId: STATION_OCPP_ID,
          internalStationId: INTERNAL_STATION_ID,
          ocppProtocol: 'ocpp2.1',
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(mockRenderStationMessage).toHaveBeenCalledWith('available', expect.any(Object));
    });

    it('logs a warning when the payload is not valid JSON', async () => {
      const handler = await getHandler();
      handler('{not json');
      await new Promise((r) => setTimeout(r, 10));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'station_message_refresh handler failed',
      );
    });
  });

  describe('startStationMessageTransactionListener', () => {
    async function getHandler() {
      await startStationMessageTransactionListener(mockLogger as never);
      const call = mockSubscribe.mock.calls.find((c) => c[0] === 'station_message_transaction');
      return call?.[1] as (raw: string) => void;
    }

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
    };

    it('ignores payloads missing required fields', async () => {
      const handler = await getHandler();
      handler(JSON.stringify({ sessionId: 'ses_1' }));
      await new Promise((r) => setTimeout(r, 10));
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('clears all transaction slots on an ended event', async () => {
      setupDbResults([{ ocppMessageId: STATION_MESSAGE_SLOT_CHARGING }]);
      const handler = await getHandler();
      handler(
        JSON.stringify({
          sessionId: 'ses_1',
          internalStationId: INTERNAL_STATION_ID,
          stationOcppId: STATION_OCPP_ID,
          ocppProtocol: 'ocpp2.1',
          eventType: 'ended',
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      const cleared = mockPublish.mock.calls.some((c) => {
        const body = JSON.parse(c[1] as string) as { action: string };
        return body.action === 'ClearDisplayMessage';
      });
      expect(cleared).toBe(true);
    });

    it('returns when the session row is not found', async () => {
      setupDbResults([]); // loadTransactionSessionById -> empty
      const handler = await getHandler();
      handler(
        JSON.stringify({
          sessionId: 'ses_missing',
          internalStationId: INTERNAL_STATION_ID,
          stationOcppId: STATION_OCPP_ID,
          ocppProtocol: 'ocpp2.1',
          eventType: 'updated',
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(mockRenderStationMessage).not.toHaveBeenCalled();
    });

    it('loads the session and pushes a transaction message on an updated event', async () => {
      // 1) loadTransactionSessionById -> [SESSION_DB_ROW]
      // then pushTransactionMessage: existing pushes [], power [], driver (null) skipped, insert []
      setupDbResults([SESSION_DB_ROW], [], [], []);
      const handler = await getHandler();
      handler(
        JSON.stringify({
          sessionId: 'ses_1',
          internalStationId: INTERNAL_STATION_ID,
          stationOcppId: STATION_OCPP_ID,
          ocppProtocol: 'ocpp2.1',
          eventType: 'updated',
          chargingState: 'Charging',
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(mockRenderStationMessage).toHaveBeenCalledWith('charging', expect.any(Object));
    });

    it('logs a warning on malformed JSON', async () => {
      const handler = await getHandler();
      handler('not-json');
      await new Promise((r) => setTimeout(r, 10));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'station_message_transaction handler failed',
      );
    });
  });

  describe('pushAllMessagesToAllStations', () => {
    it('pushes to every online OCPP 2.1 station and logs the count', async () => {
      // 1) online stations list
      // then for the single 2.1 station: pushAllStationMessages runs its own queries.
      // station2 is 1.6 so pushAllStationMessages returns early (no DB queries).
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

      await pushAllMessagesToAllStations(mockLogger as never);

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
        // sta_b is 1.6 -> returns before any DB query.
      );

      await pushAllMessagesToAllStations(mockLogger as never);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: 'CS-A' }),
        'Failed to push station messages to station',
      );
    });

    it('does not log when there are no online stations', async () => {
      setupDbResults([]);

      await pushAllMessagesToAllStations(mockLogger as never);

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Station messages pushed to stations',
      );
    });
  });
});
