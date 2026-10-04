// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { postMock, getMock } = vi.hoisted(() => ({ postMock: vi.fn(), getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock } };
});

import { ApiError } from '@/lib/api';
import {
  fetchDescriptor,
  newAttemptId,
  startSetup,
  submitGuestPaymentDetails,
  submitSetup,
  submitSetupDetails,
} from '../api';

describe('payments api', () => {
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
  });

  it('reads the descriptor', async () => {
    const descriptor = { paymentEnabled: false, provider: null, capabilities: null };
    getMock.mockResolvedValue(descriptor);
    await expect(fetchDescriptor()).resolves.toEqual(descriptor);
    expect(getMock).toHaveBeenCalledWith('/v1/portal/payment-provider');
  });

  it('starts a setup and returns the session', async () => {
    const session = { provider: 'stripe', customerId: 'cus_1', clientSecret: 'seti_1_secret' };
    postMock.mockResolvedValue({ provider: 'stripe', session });
    await expect(startSetup()).resolves.toEqual(session);
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payment-methods/setup-intent', {});
  });

  it('creates a UUID attempt id per form', () => {
    const a = newAttemptId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newAttemptId()).not.toBe(a);
  });

  it('posts submit with provider, attemptId and payload and maps saved', async () => {
    postMock.mockResolvedValue({ status: 'saved', method: { id: 1 } });
    await expect(submitSetup('att-1', 'stripe', { paymentMethodId: 'pm_1' })).resolves.toEqual({
      status: 'saved',
    });
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payment-methods/setup/submit', {
      provider: 'stripe',
      attemptId: 'att-1',
      payload: { paymentMethodId: 'pm_1' },
    });
  });

  it('posts details and maps action_required', async () => {
    const action = { provider: 'simulated', data: { methodId: 'm1' } };
    postMock.mockResolvedValue({ status: 'action_required', action });
    await expect(submitSetupDetails('att-1', 'simulated', { outcome: 'approve' })).resolves.toEqual(
      { status: 'action_required', action },
    );
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payment-methods/setup/details', {
      provider: 'simulated',
      attemptId: 'att-1',
      details: { outcome: 'approve' },
    });
  });

  it('maps 400 PAYMENT_FAILED to refused with the reason', async () => {
    postMock.mockRejectedValue(
      new ApiError(400, { code: 'PAYMENT_FAILED', details: { reason: 'card_declined' } }),
    );
    await expect(submitSetup('att-1', 'stripe', {})).resolves.toEqual({
      status: 'refused',
      reason: 'card_declined',
    });
  });

  it('rethrows other API errors', async () => {
    const err = new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
    postMock.mockRejectedValue(err);
    await expect(submitSetup('att-1', 'stripe', {})).rejects.toBe(err);
  });

  it('sends the shopper browser with a submit when given', async () => {
    postMock.mockResolvedValue({ status: 'saved', method: { id: 1 } });
    const browser = { origin: 'https://portal.test', info: { language: 'en' } };
    await submitSetup('att-1', 'adyen', { currency: 'USD' }, browser);
    expect(postMock).toHaveBeenCalledWith('/v1/portal/payment-methods/setup/submit', {
      provider: 'adyen',
      attemptId: 'att-1',
      payload: { currency: 'USD' },
      browser,
    });
  });

  it('posts guest 3D Secure details for the session', async () => {
    postMock.mockResolvedValue({ status: 'started', sessionToken: 'tok 1' });
    await expect(
      submitGuestPaymentDetails('tok 1', { details: { redirectResult: 'r' } }),
    ).resolves.toEqual({
      status: 'started',
      sessionToken: 'tok 1',
    });
    expect(postMock).toHaveBeenCalledWith('/v1/portal/guest/payment-details/tok%201', {
      details: { details: { redirectResult: 'r' } },
    });
  });
});
