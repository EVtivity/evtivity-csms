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
  mockCapturePayment,
  mockCancelPaymentIntent,
  mockGetStripeConfig,
  mockEnd,
  mockDispatchSystemNotification,
} = vi.hoisted(() => ({
  mockCapturePayment: vi.fn().mockResolvedValue({}),
  mockCancelPaymentIntent: vi.fn().mockResolvedValue({}),
  mockGetStripeConfig: vi.fn(),
  mockEnd: vi.fn().mockResolvedValue(undefined),
  mockDispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
}));

// -- Mocks --

let listenCallback: ((payload: string) => void) | null = null;

const mockPubSub = {
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn((_channel: string, handler: (payload: string) => void) => {
    listenCallback = handler;
    return Promise.resolve({ unsubscribe: mockEnd });
  }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
  },
  client: {},
  guestSessions: {
    sessionToken: 'sessionToken',
    status: 'status',
    chargingSessionId: 'chargingSessionId',
    id: 'id',
    guestEmail: 'guestEmail',
    stationOcppId: 'stationOcppId',
  },
  chargingSessions: {
    id: 'id',
    finalCostCents: 'finalCostCents',
    stationId: 'stationId',
    energyDeliveredWh: 'energyDeliveredWh',
    currency: 'currency',
    startedAt: 'startedAt',
    endedAt: 'endedAt',
  },
  chargingStations: { id: 'id', siteId: 'siteId', stationId: 'stationId' },
  paymentRecords: {
    id: 'id',
    sessionId: 'sessionId',
    stripePaymentIntentId: 'stripePaymentIntentId',
    status: 'status',
    capturedAmountCents: 'capturedAmountCents',
    failureReason: 'failureReason',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: mockGetStripeConfig,
  capturePayment: mockCapturePayment,
  cancelPaymentIntent: mockCancelPaymentIntent,
}));

const mockPgEnd = vi.fn().mockResolvedValue(undefined);
const mockPgTagged = vi.fn().mockResolvedValue([]);
vi.mock('postgres', () => ({
  default: vi.fn(() => {
    const fn = mockPgTagged as unknown as Record<string, unknown>;
    fn.end = mockPgEnd;
    return fn;
  }),
}));

vi.mock('@evtivity/lib', () => ({
  dispatchSystemNotification: mockDispatchSystemNotification,
}));

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
  API_TEMPLATES_DIR: '/mock/templates',
  OCPP_TEMPLATES_DIR: '/mock/templates',
}));

// -- Import under test (after mocks) --

import { startGuestSessionListener } from '../services/guest-session.service.js';

// -- Helpers --

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function fireEvent(event: Record<string, unknown>) {
  listenCallback!(JSON.stringify(event));
}

async function tick(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

// -- Tests --

describe('guest-session.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenCallback = null;
    setupDbResults();
    mockGetStripeConfig.mockResolvedValue({ stripe: {} });
  });

  describe('startGuestSessionListener', () => {
    it('returns a stop function', () => {
      const stop = startGuestSessionListener(mockPubSub as never, mockLogger as never);
      expect(typeof stop).toBe('function');
      stop();
    });

    it('stop function calls end() on connection', async () => {
      const stop = startGuestSessionListener(mockPubSub as never, mockLogger as never);
      stop();
      await tick();
      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe('TransactionStarted', () => {
    it('links guest session when matching session exists', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      // DB call 1: find guest session by token -> found
      // DB call 2: update guest session
      setupDbResults(
        [{ id: 'guest-1', sessionToken: 'TOKEN-1', status: 'payment_authorized' }],
        [],
      );

      fireEvent({
        type: 'TransactionStarted',
        idToken: { idToken: 'TOKEN-1', type: 'ISO14443' },
        sessionId: 'session-1',
      });
      await tick();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1', chargingSessionId: 'session-1' },
        'Linked guest session to charging session',
      );
    });

    it('is a no-op when no matching guest session exists', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      setupDbResults([]);

      fireEvent({
        type: 'TransactionStarted',
        idToken: { idToken: 'TOKEN-UNKNOWN', type: 'ISO14443' },
        sessionId: 'session-1',
      });
      await tick();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ guestSessionId: expect.any(String) }),
        'Linked guest session to charging session',
      );
    });

    it('is a no-op when no idToken present', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      fireEvent({ type: 'TransactionStarted', sessionId: 'session-1' });
      await tick();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ guestSessionId: expect.any(String) }),
        'Linked guest session to charging session',
      );
    });
  });

  describe('TransactionEnded', () => {
    it('captures payment when guest session has positive cost', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      // DB call 1: find guest session (id, guestEmail, stationOcppId)
      // DB call 2: find payment record (id, stripePaymentIntentId)
      // DB call 3: find charging session (finalCostCents, stationId)
      // DB call 4: find station (siteId)
      // DB call 5+: updates
      setupDbResults(
        [{ id: 'guest-1', guestEmail: 'guest@test.com', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc' }],
        [{ finalCostCents: 3500, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
        [],
      );

      fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).toHaveBeenCalledWith(expect.anything(), 'pi_abc', 3500);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1', amountCents: 3500 },
        'Captured guest payment',
      );
    });

    it('cancels payment intent when cost is zero', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc' }],
        [{ finalCostCents: 0, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
        [],
      );

      fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCancelPaymentIntent).toHaveBeenCalledWith(expect.anything(), 'pi_abc');
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1' },
        'Cancelled zero-cost guest payment intent',
      );
    });

    it('is a no-op when no guest session linked', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      setupDbResults([]);

      fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('completes free session when no payment record exists', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      // DB call 1: find guest session
      // DB call 2: find payment record -> empty (no payment)
      // DB call 3: update guest session to completed
      setupDbResults([{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }], [], []);

      fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1' },
        'Free guest session completed',
      );
    });

    it('sends receipt notification when guest provided email', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      // DB call 1: find guest session with email
      // DB call 2: find payment record -> empty (free)
      // DB call 3: update guest session to completed
      // DB call 4: sendGuestReceipt -> select charging session
      setupDbResults(
        [{ id: 'guest-1', guestEmail: 'receipt@test.com', stationOcppId: 'CS-001' }],
        [],
        [],
        [
          {
            energyDeliveredWh: '5000',
            finalCostCents: 0,
            currency: 'USD',
            startedAt: '2026-01-01T00:00:00Z',
            endedAt: '2026-01-01T01:00:00Z',
          },
        ],
      );

      fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockDispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'session.Receipt',
        { email: 'receipt@test.com' },
        expect.objectContaining({
          stationId: 'CS-001',
          currency: 'USD',
        }),
        expect.any(Array),
      );
    });

    it('sets status to failed when stripe error occurs', async () => {
      startGuestSessionListener(mockPubSub as never, mockLogger as never);
      await tick();

      mockCapturePayment.mockRejectedValueOnce(new Error('Stripe API error'));

      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc' }],
        [{ finalCostCents: 5000, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
        [],
      );

      fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), guestSessionId: 'guest-1' }),
        'Failed to finalize guest payment',
      );
    });
  });
});
