// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// Mock @evtivity/database
vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
  paymentRecords: {
    id: 'id',
    createdAt: 'createdAt',
    stripePaymentIntentId: 'stripePaymentIntentId',
  },
}));

// Mock stripe.service
vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn(),
}));

import {
  reconcilePayments,
  mapStripeStatusToLocal,
} from '../services/payment-reconciliation.service.js';
import { getStripeConfig } from '../services/stripe.service.js';
import { db } from '@evtivity/database';

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as FastifyBaseLogger;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcilePayments', () => {
  it('returns empty result with error when Stripe not configured', async () => {
    vi.mocked(getStripeConfig).mockResolvedValue(null);

    const result = await reconcilePayments(mockLog);

    expect(result.checked).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.errors).toContain('Stripe not configured');
  });

  it('detects status discrepancy', async () => {
    const mockStripe = {
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          status: 'succeeded',
          amount_received: 1500,
        }),
      },
    };

    vi.mocked(getStripeConfig).mockResolvedValue({
      stripe: mockStripe as never,
      publishableKey: 'pk_test',
      currency: 'USD',
      preAuthAmountCents: 5000,
      configId: null,
      connectedAccountId: null,
      platformFeePercent: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: 1,
                  stripePaymentIntentId: 'pi_test_123',
                  status: 'pre_authorized',
                  capturedAmountCents: null,
                  createdAt: new Date(),
                },
              ])
              .mockResolvedValueOnce([]),
          }),
        }),
      }),
    } as never);

    const result = await reconcilePayments(mockLog);

    expect(result.checked).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.field).toBe('status');
    expect(result.discrepancies[0]?.localValue).toBe('pre_authorized');
    expect(result.discrepancies[0]?.stripeValue).toContain('succeeded');
  });

  it('matches when status and amount agree', async () => {
    const mockStripe = {
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          status: 'succeeded',
          amount_received: 1500,
        }),
      },
    };

    vi.mocked(getStripeConfig).mockResolvedValue({
      stripe: mockStripe as never,
      publishableKey: 'pk_test',
      currency: 'USD',
      preAuthAmountCents: 5000,
      configId: null,
      connectedAccountId: null,
      platformFeePercent: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: 1,
                  stripePaymentIntentId: 'pi_test_123',
                  status: 'captured',
                  capturedAmountCents: 1500,
                  createdAt: new Date(),
                },
              ])
              .mockResolvedValueOnce([]),
          }),
        }),
      }),
    } as never);

    const result = await reconcilePayments(mockLog);

    expect(result.checked).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('handles Stripe API errors gracefully', async () => {
    const mockStripe = {
      paymentIntents: {
        retrieve: vi.fn().mockRejectedValue(new Error('Stripe rate limit exceeded')),
      },
    };

    vi.mocked(getStripeConfig).mockResolvedValue({
      stripe: mockStripe as never,
      publishableKey: 'pk_test',
      currency: 'USD',
      preAuthAmountCents: 5000,
      configId: null,
      connectedAccountId: null,
      platformFeePercent: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: 1,
                  stripePaymentIntentId: 'pi_test_123',
                  status: 'captured',
                  capturedAmountCents: 1500,
                  createdAt: new Date(),
                },
              ])
              .mockResolvedValueOnce([]),
          }),
        }),
      }),
    } as never);

    const result = await reconcilePayments(mockLog);

    expect(result.checked).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Stripe rate limit exceeded');
  });

  it('skips records without stripe payment intent ID', async () => {
    const mockStripe = {
      paymentIntents: { retrieve: vi.fn() },
    };

    vi.mocked(getStripeConfig).mockResolvedValue({
      stripe: mockStripe as never,
      publishableKey: 'pk_test',
      currency: 'USD',
      preAuthAmountCents: 5000,
      configId: null,
      connectedAccountId: null,
      platformFeePercent: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: 1,
                  stripePaymentIntentId: null,
                  status: 'pending',
                  capturedAmountCents: null,
                  createdAt: new Date(),
                },
                {
                  id: 2,
                  stripePaymentIntentId: '',
                  status: 'pending',
                  capturedAmountCents: null,
                  createdAt: new Date(),
                },
              ])
              .mockResolvedValueOnce([]),
          }),
        }),
      }),
    } as never);

    const result = await reconcilePayments(mockLog);

    expect(result.checked).toBe(0);
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('detects captured amount discrepancy', async () => {
    const mockStripe = {
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          status: 'succeeded',
          amount_received: 2000,
        }),
      },
    };

    vi.mocked(getStripeConfig).mockResolvedValue({
      stripe: mockStripe as never,
      publishableKey: 'pk_test',
      currency: 'USD',
      preAuthAmountCents: 5000,
      configId: null,
      connectedAccountId: null,
      platformFeePercent: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: 1,
                  stripePaymentIntentId: 'pi_test_123',
                  status: 'captured',
                  capturedAmountCents: 1500,
                  createdAt: new Date(),
                },
              ])
              .mockResolvedValueOnce([]),
          }),
        }),
      }),
    } as never);

    const result = await reconcilePayments(mockLog);

    expect(result.checked).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.field).toBe('capturedAmountCents');
    expect(result.discrepancies[0]?.localValue).toBe('1500');
    expect(result.discrepancies[0]?.stripeValue).toBe('2000');
  });
});

describe('mapStripeStatusToLocal', () => {
  it('maps requires_payment_method to pending', () => {
    expect(mapStripeStatusToLocal('requires_payment_method')).toBe('pending');
  });

  it('maps requires_confirmation to pending', () => {
    expect(mapStripeStatusToLocal('requires_confirmation')).toBe('pending');
  });

  it('maps requires_action to pending', () => {
    expect(mapStripeStatusToLocal('requires_action')).toBe('pending');
  });

  it('maps processing to pending', () => {
    expect(mapStripeStatusToLocal('processing')).toBe('pending');
  });

  it('maps requires_capture to pre_authorized', () => {
    expect(mapStripeStatusToLocal('requires_capture')).toBe('pre_authorized');
  });

  it('maps succeeded to captured', () => {
    expect(mapStripeStatusToLocal('succeeded')).toBe('captured');
  });

  it('maps canceled to cancelled', () => {
    expect(mapStripeStatusToLocal('canceled')).toBe('cancelled');
  });

  it('returns null for unknown status', () => {
    expect(mapStripeStatusToLocal('unknown_status')).toBeNull();
  });
});
