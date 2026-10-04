// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { submitMock, detailsMock, attemptMock } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  detailsMock: vi.fn(),
  attemptMock: vi.fn(),
}));

vi.mock('../api', () => ({
  newAttemptId: attemptMock,
  submitSetup: submitMock,
  submitSetupDetails: detailsMock,
}));

import { createCardSetupSteps } from '../setup-attempt';

describe('createCardSetupSteps', () => {
  beforeEach(() => {
    submitMock.mockReset();
    detailsMock.mockReset();
    let n = 0;
    attemptMock.mockReset();
    attemptMock.mockImplementation(() => `attempt-${String(++n)}`);
  });

  it('posts submit and details for the driver with one attempt id', async () => {
    submitMock.mockResolvedValue({ status: 'action_required', action: { provider: 'x' } });
    detailsMock.mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('drv_1', 'simulated');
    await steps.submit({ testCard: '4000002500003155' });
    await steps.submitDetails({ methodId: 'pm', outcome: 'approve' });
    expect(submitMock).toHaveBeenCalledWith(
      'drv_1',
      'attempt-1',
      'simulated',
      {
        testCard: '4000002500003155',
      },
      undefined,
    );
    expect(detailsMock).toHaveBeenCalledWith('drv_1', 'attempt-1', 'simulated', {
      methodId: 'pm',
      outcome: 'approve',
    });
  });

  it('keeps the attempt id after an error and starts a new one after a refusal', async () => {
    submitMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 'refused', reason: 'card_declined' })
      .mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('drv_1', 'simulated');
    await expect(steps.submit({})).rejects.toThrow('network');
    await steps.submit({});
    await steps.submit({});
    expect(submitMock.mock.calls.map((c) => c[1] as string)).toEqual([
      'attempt-1',
      'attempt-1',
      'attempt-2',
    ]);
  });

  it('passes the shopper browser of a 3D Secure capable card UI', async () => {
    submitMock.mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('drv_1', 'adyen');
    const browser = { origin: 'https://app.test', info: { userAgent: 'ua' } };
    await steps.submit({ paymentMethod: { type: 'scheme' } }, browser);
    expect(submitMock).toHaveBeenCalledWith(
      'drv_1',
      'attempt-1',
      'adyen',
      { paymentMethod: { type: 'scheme' } },
      browser,
    );
  });
});
