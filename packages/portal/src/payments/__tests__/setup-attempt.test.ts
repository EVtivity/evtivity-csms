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
    attemptMock.mockReset();
    let n = 0;
    attemptMock.mockImplementation(() => `attempt-${String(++n)}`);
  });

  it('uses one attempt id for the submit and the details of one form', async () => {
    submitMock.mockResolvedValue({ status: 'action_required', action: { provider: 'x' } });
    detailsMock.mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('simulated');
    await steps.submit({ testCard: '4000002500003155' });
    await steps.submitDetails({ methodId: 'pm', outcome: 'approve' });
    expect(submitMock).toHaveBeenCalledWith(
      'attempt-1',
      'simulated',
      {
        testCard: '4000002500003155',
      },
      undefined,
    );
    expect(detailsMock).toHaveBeenCalledWith('attempt-1', 'simulated', {
      methodId: 'pm',
      outcome: 'approve',
    });
  });

  it('keeps the attempt id after a thrown error, so a retry replays it', async () => {
    submitMock.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('simulated');
    await expect(steps.submit({ testCard: '4242424242424242' })).rejects.toThrow('network');
    await steps.submit({ testCard: '4242424242424242' });
    expect(submitMock.mock.calls.map((c) => c[0] as string)).toEqual(['attempt-1', 'attempt-1']);
  });

  it('starts a new attempt after a refused card', async () => {
    submitMock
      .mockResolvedValueOnce({ status: 'refused', reason: 'card_declined' })
      .mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('simulated');
    await expect(steps.submit({ testCard: '4000000000000002' })).resolves.toEqual({
      status: 'refused',
      reason: 'card_declined',
    });
    await steps.submit({ testCard: '4242424242424242' });
    expect(submitMock.mock.calls.map((c) => c[0] as string)).toEqual(['attempt-1', 'attempt-2']);
  });

  it('starts a new attempt after a failed challenge', async () => {
    detailsMock.mockResolvedValue({ status: 'refused', reason: 'authentication_failed' });
    submitMock.mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('simulated');
    await steps.submitDetails({ methodId: 'pm', outcome: 'fail' });
    await steps.submit({ testCard: '4242424242424242' });
    expect(submitMock).toHaveBeenCalledWith(
      'attempt-2',
      'simulated',
      {
        testCard: '4242424242424242',
      },
      undefined,
    );
  });

  it('passes the shopper browser of a 3D Secure capable card UI', async () => {
    submitMock.mockResolvedValue({ status: 'saved' });
    const steps = createCardSetupSteps('adyen');
    const browser = { origin: 'https://app.test', info: { userAgent: 'ua' } };
    await steps.submit({ paymentMethod: { type: 'scheme' } }, browser);
    expect(submitMock).toHaveBeenCalledWith(
      'attempt-1',
      'adyen',
      { paymentMethod: { type: 'scheme' } },
      browser,
    );
  });
});
