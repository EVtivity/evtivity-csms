// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishMock = vi.fn(async () => undefined);

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: (): { publish: typeof publishMock } => ({ publish: publishMock }),
}));

import { notifySupportCaseEvent } from '../lib/support-case-events.js';

beforeEach(() => {
  publishMock.mockClear();
});

describe('notifySupportCaseEvent', () => {
  it('publishes to csms_events and portal_events when driverId is set', async () => {
    await notifySupportCaseEvent('supportCase.created', 'cas_1', 'drv_9');

    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenNthCalledWith(
      1,
      'csms_events',
      JSON.stringify({ eventType: 'supportCase.created', caseId: 'cas_1' }),
    );
    expect(publishMock).toHaveBeenNthCalledWith(
      2,
      'portal_events',
      JSON.stringify({ type: 'supportCase.created', caseId: 'cas_1', driverId: 'drv_9' }),
    );
  });

  it('publishes only to csms_events when driverId is null', async () => {
    await notifySupportCaseEvent('supportCase.updated', 'cas_2', null);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'supportCase.updated', caseId: 'cas_2' }),
    );
  });

  it('carries the newMessage event type through both channels', async () => {
    await notifySupportCaseEvent('supportCase.newMessage', 'cas_3', 'drv_3');

    expect(publishMock).toHaveBeenNthCalledWith(
      1,
      'csms_events',
      JSON.stringify({ eventType: 'supportCase.newMessage', caseId: 'cas_3' }),
    );
    expect(publishMock).toHaveBeenNthCalledWith(
      2,
      'portal_events',
      JSON.stringify({ type: 'supportCase.newMessage', caseId: 'cas_3', driverId: 'drv_3' }),
    );
  });
});
