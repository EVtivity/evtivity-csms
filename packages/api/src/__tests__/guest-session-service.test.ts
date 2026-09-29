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
  mockDispatchSystemNotification,
} = vi.hoisted(() => ({
  mockCapturePayment: vi.fn().mockResolvedValue({}),
  mockCancelPaymentIntent: vi.fn().mockResolvedValue({}),
  mockGetStripeConfig: vi.fn(),
  mockDispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
}));

// -- Mocks --

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
  },
  client: {},
  getCompanyCurrency: vi.fn().mockResolvedValue('EUR'),
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
  sql: vi.fn(() => ({})),
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

import { db } from '@evtivity/database';
import { handleGuestSessionEvent } from '../services/guest-session.service.js';

// -- Helpers --

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

async function fireEvent(event: Record<string, unknown>): Promise<void> {
  await handleGuestSessionEvent(event as never, mockLogger as never).catch(() => {
    // Match the pre-removal listener wrapper, which swallowed errors after
    // logging via logger.error inside finalizeGuestPayment. Tests that need
    // to assert on a thrown error already do so via the mockCapturePayment
    // rejection path; they assert on logger.error, not on thrown errors.
  });
}

async function tick(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

// -- Tests --

describe('guest-session.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    mockGetStripeConfig.mockResolvedValue({ stripe: {} });
  });

  describe('TransactionStarted', () => {
    it('links guest session when matching session exists', async () => {
      // DB call 1: find guest session by token -> found
      // DB call 2: update guest session
      setupDbResults(
        [{ id: 'guest-1', sessionToken: 'TOKEN-1', status: 'payment_authorized' }],
        [],
      );

      await fireEvent({
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
      setupDbResults([]);

      await fireEvent({
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
      await fireEvent({ type: 'TransactionStarted', sessionId: 'session-1' });
      await tick();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ guestSessionId: expect.any(String) }),
        'Linked guest session to charging session',
      );
    });

    it('returns without updating when a matching guest exists but the event has no sessionId', async () => {
      // Guest found, but sessionId is null -> linkGuestSession bails before
      // updating and never logs the link message.
      setupDbResults([{ id: 'guest-1', sessionToken: 'TOKEN-1', status: 'payment_authorized' }]);

      await fireEvent({
        type: 'TransactionStarted',
        idToken: { idToken: 'TOKEN-1', type: 'ISO14443' },
      });
      await tick();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ guestSessionId: 'guest-1' }),
        'Linked guest session to charging session',
      );
    });

    it('stamps the payment record with the linked session currency', async () => {
      mockGetStripeConfig.mockResolvedValueOnce({ configId: 7, currency: 'EUR' });
      // 1: find guest (has stripePaymentIntentId)
      // 2: update guest session
      // 3: find station siteId
      // 4: linked charging session currency
      // 5: insert payment record
      setupDbResults(
        [
          {
            id: 'guest-1',
            sessionToken: 'TOKEN-1',
            status: 'payment_authorized',
            stripePaymentIntentId: 'pi_guest',
            stationOcppId: 'CS-001',
            preAuthAmountCents: 4000,
          },
        ],
        [],
        [{ siteId: 'site-1' }],
        [{ currency: 'GBP' }],
        [],
      );

      await fireEvent({
        type: 'TransactionStarted',
        idToken: { idToken: 'TOKEN-1', type: 'ISO14443' },
        sessionId: 'session-1',
      });
      await tick();

      expect(mockGetStripeConfig).toHaveBeenCalledWith('site-1');
      const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ sitePaymentConfigId: 7, currency: 'GBP' }),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1', chargingSessionId: 'session-1' },
        'Linked guest session to charging session',
      );
    });

    it('defaults the payment record to no config and the company currency when no station/site found', async () => {
      mockGetStripeConfig.mockResolvedValueOnce(null);
      // 1: find guest (has intent)
      // 2: update guest session
      // 3: find station -> empty (no siteId)
      // 4: linked charging session -> missing, so the company currency applies
      // 5: insert payment record
      setupDbResults(
        [
          {
            id: 'guest-2',
            sessionToken: 'TOKEN-2',
            status: 'payment_authorized',
            stripePaymentIntentId: 'pi_guest2',
            stationOcppId: 'CS-002',
            preAuthAmountCents: 4000,
          },
        ],
        [],
        [],
        [],
        [],
      );

      await fireEvent({
        type: 'TransactionStarted',
        idToken: { idToken: 'TOKEN-2', type: 'ISO14443' },
        sessionId: 'session-2',
      });
      await tick();

      expect(mockGetStripeConfig).toHaveBeenCalledWith(null);
      const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ sitePaymentConfigId: null, currency: 'EUR' }),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-2', chargingSessionId: 'session-2' },
        'Linked guest session to charging session',
      );
    });
  });

  describe('TransactionEnded', () => {
    it('captures payment when guest session has positive cost', async () => {
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

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).toHaveBeenCalledWith(
        expect.anything(),
        'pi_abc',
        3500,
        'capture_pr-1',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1', amountCents: 3500 },
        'Captured guest payment',
      );
    });

    it('cancels payment intent when cost is zero', async () => {
      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc' }],
        [{ finalCostCents: 0, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
        [],
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCancelPaymentIntent).toHaveBeenCalledWith(expect.anything(), 'pi_abc');
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1' },
        'Cancelled zero-cost guest payment intent',
      );
    });

    it('is a no-op when no guest session linked', async () => {
      setupDbResults([]);

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('completes free session when no payment record exists', async () => {
      // DB call 1: find guest session
      // DB call 2: find payment record -> empty (no payment)
      // DB call 3: update guest session to completed
      setupDbResults([{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }], [], []);

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1' },
        'Free guest session completed',
      );
    });

    it('sends receipt notification when guest provided email', async () => {
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

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
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
      mockCapturePayment.mockRejectedValueOnce(new Error('Stripe API error'));

      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc' }],
        [{ finalCostCents: 5000, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
        [],
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), guestSessionId: 'guest-1' }),
        'Failed to finalize guest payment',
      );
    });

    it('uses the Unknown payment error fallback for a non-Error throw', async () => {
      mockCapturePayment.mockRejectedValueOnce('a string failure');

      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc' }],
        [{ finalCostCents: 5000, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
        [],
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ guestSessionId: 'guest-1' }),
        'Failed to finalize guest payment',
      );
    });

    it('skips finalization when the payment is already in a terminal state', async () => {
      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc', status: 'captured' }],
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1', paymentRecordId: 'pr-1', status: 'captured' },
        'Skipping guest payment finalization, already terminal',
      );
    });

    it('returns when the charging session row is missing', async () => {
      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc', status: 'pre_authorized' }],
        [], // charging session not found
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('marks the guest session completed when no Stripe config exists for capture', async () => {
      mockGetStripeConfig.mockResolvedValueOnce(null);
      setupDbResults(
        [{ id: 'guest-1', guestEmail: '', stationOcppId: 'CS-001' }],
        [{ id: 'pr-1', stripePaymentIntentId: 'pi_abc', status: 'pre_authorized' }],
        [{ finalCostCents: 3500, stationId: 'station-1' }],
        [{ siteId: 'site-1' }],
        [],
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockCapturePayment).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        { guestSessionId: 'guest-1' },
        'No Stripe config for guest payment capture',
      );
    });

    it('logs and swallows a receipt notification failure', async () => {
      mockDispatchSystemNotification.mockRejectedValueOnce(new Error('SMTP down'));
      // Free session path with email so sendGuestReceipt runs and throws.
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

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), guestSessionId: 'guest-1' }),
        'Failed to send guest receipt notification',
      );
    });

    it('skips the receipt when the charging session is missing inside sendGuestReceipt', async () => {
      // Free session with email, but the receipt-time charging session lookup
      // returns empty -> sendGuestReceipt returns before dispatching.
      setupDbResults(
        [{ id: 'guest-1', guestEmail: 'receipt@test.com', stationOcppId: 'CS-001' }],
        [],
        [],
        [], // charging session lookup inside sendGuestReceipt: empty
      );

      await fireEvent({ type: 'TransactionEnded', sessionId: 'session-1' });
      await tick();

      expect(mockDispatchSystemNotification).not.toHaveBeenCalled();
    });
  });
});
