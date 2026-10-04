// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { post: postMock } };
});

import { ApiError } from '@/lib/api';
import { newAttemptId, startSetup, submitSetup, submitSetupDetails } from '../api';

describe('operator payments api', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('starts a setup for the driver and returns the session', async () => {
    const session = { provider: 'stripe', customerId: 'cus_1', clientSecret: 'seti_1_secret' };
    postMock.mockResolvedValue({ provider: 'stripe', session });
    await expect(startSetup('drv_1')).resolves.toEqual(session);
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/payment-methods/setup-intent', {});
  });

  it('creates a UUID attempt id per form', () => {
    const a = newAttemptId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newAttemptId()).not.toBe(a);
  });

  it('posts submit for the driver and maps saved', async () => {
    postMock.mockResolvedValue({ status: 'saved', method: { id: '1' } });
    await expect(
      submitSetup('drv_1', 'att-1', 'stripe', { paymentMethodId: 'pm_1' }),
    ).resolves.toEqual({ status: 'saved' });
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/payment-methods/setup/submit', {
      provider: 'stripe',
      attemptId: 'att-1',
      payload: { paymentMethodId: 'pm_1' },
    });
  });

  it('posts details and maps action_required', async () => {
    const action = { provider: 'simulated', data: { methodId: 'm1' } };
    postMock.mockResolvedValue({ status: 'action_required', action });
    await expect(
      submitSetupDetails('drv_1', 'att-1', 'simulated', { outcome: 'fail' }),
    ).resolves.toEqual({ status: 'action_required', action });
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/payment-methods/setup/details', {
      provider: 'simulated',
      attemptId: 'att-1',
      details: { outcome: 'fail' },
    });
  });

  it('maps 400 PAYMENT_FAILED to refused with the reason', async () => {
    postMock.mockRejectedValue(
      new ApiError(400, { code: 'PAYMENT_FAILED', details: { reason: 'do_not_honor' } }),
    );
    await expect(submitSetup('drv_1', 'att-1', 'stripe', {})).resolves.toEqual({
      status: 'refused',
      reason: 'do_not_honor',
    });
  });

  it('rethrows other API errors', async () => {
    const err = new ApiError(403, { code: 'FORBIDDEN' });
    postMock.mockRejectedValue(err);
    await expect(submitSetup('drv_1', 'att-1', 'stripe', {})).rejects.toBe(err);
  });

  it('sends the shopper browser with a submit when given', async () => {
    postMock.mockResolvedValue({ status: 'saved', method: { id: '1' } });
    const browser = { origin: 'https://csms.test' };
    await submitSetup('drv_1', 'att-1', 'adyen', { currency: 'USD' }, browser);
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/payment-methods/setup/submit', {
      provider: 'adyen',
      attemptId: 'att-1',
      payload: { currency: 'USD' },
      browser,
    });
  });
});
