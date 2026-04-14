// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);

vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}));

vi.mock('@evtivity/api/src/services/guest-session.service.js', () => ({
  handleGuestSessionEvent: vi.fn().mockResolvedValue(undefined),
}));

describe('startGuestSessionBridge', () => {
  it('enqueues a job with sessionId as jobId on TransactionEnded', async () => {
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const mockQueue = { add: mockAdd } as never;
    const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
    const mockPubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'TransactionEnded', sessionId: 'ses_abc123' }));
        return Promise.resolve({ unsubscribe: mockUnsubscribe });
      },
    } as never;

    await startGuestSessionBridge(mockPubsub, mockQueue);

    expect(mockAdd).toHaveBeenCalledWith(
      'guest-session-ended',
      { sessionId: 'ses_abc123' },
      expect.objectContaining({ jobId: 'guest-session-ended-ses_abc123' }),
    );
  });

  it('enqueues a job on TransactionStarted with idToken', async () => {
    mockAdd.mockClear();
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const mockQueue = { add: mockAdd } as never;
    const mockPubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(
          JSON.stringify({
            type: 'TransactionStarted',
            idToken: { idToken: 'TOKEN123', type: 'ISO14443' },
          }),
        );
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(mockPubsub, mockQueue);

    expect(mockAdd).toHaveBeenCalledWith(
      'guest-session-started',
      expect.objectContaining({ event: expect.objectContaining({ type: 'TransactionStarted' }) }),
      expect.objectContaining({ jobId: 'guest-session-started-TOKEN123' }),
    );
  });

  it('ignores unrelated events', async () => {
    mockAdd.mockClear();
    const { startGuestSessionBridge } = await import('../guest-session-worker.js');
    const mockQueue = { add: mockAdd } as never;
    const mockPubsub = {
      subscribe: (_channel: string, handler: (msg: string) => void) => {
        handler(JSON.stringify({ type: 'StationConnected', stationId: 'STATION-1' }));
        return Promise.resolve({ unsubscribe: vi.fn() });
      },
    } as never;

    await startGuestSessionBridge(mockPubsub, mockQueue);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
