// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecute = vi.fn();
const mockDelayMs = vi.fn();
vi.mock('@evtivity/database', () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
  remoteStartTimeoutDelayMs: (...args: unknown[]) => mockDelayMs(...args),
}));

const mockFindMissing = vi.fn();
const mockScheduleCron = vi.fn().mockResolvedValue(undefined);
const mockScheduleCoordinator = vi.fn().mockResolvedValue(undefined);
vi.mock('../scheduler.js', () => ({
  findMissingSchedulers: (...args: unknown[]) => mockFindMissing(...args),
  scheduleCronJobs: (...args: unknown[]) => mockScheduleCron(...args),
  scheduleLoadManagementCoordinator: (...args: unknown[]) => mockScheduleCoordinator(...args),
}));

const mockEnqueueReservation = vi.fn().mockResolvedValue(undefined);
vi.mock('../reservation-worker.js', () => ({
  enqueueReservationActivation: (...args: unknown[]) => mockEnqueueReservation(...args),
}));
const mockEnqueueTimeout = vi.fn().mockResolvedValue(undefined);
vi.mock('../remote-start-timeout-worker.js', () => ({
  enqueueRemoteStartTimeout: (...args: unknown[]) => mockEnqueueTimeout(...args),
}));
const mockEnqueueStarted = vi.fn().mockResolvedValue(undefined);
const mockEnqueueEnded = vi.fn().mockResolvedValue(undefined);
vi.mock('../guest-session-worker.js', () => ({
  enqueueGuestSessionStarted: (...args: unknown[]) => mockEnqueueStarted(...args),
  enqueueGuestSessionEnded: (...args: unknown[]) => mockEnqueueEnded(...args),
}));

const { rebuildDelayedJobs, recoverLostRedisState, startRedisRecoveryWatch } =
  await import('../redis-recovery.js');

const redisClient = new EventEmitter();
const queues = {
  cronQueue: { getBackend: () => ({ client: Promise.resolve(redisClient) }) },
  loadQueue: {},
  reservationQueue: { name: 'reservations' },
  remoteStartTimeoutQueue: { name: 'remote-start-timeouts' },
  guestSessionQueue: { name: 'guest-session-events' },
} as never;
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

/** The four rebuild queries in order: reservations, sessions, guest starts, ended guests. */
function databaseRows(): void {
  mockExecute
    .mockResolvedValueOnce([
      { id: 'res_future', delay_ms: 90_000.4 },
      { id: 'res_due', delay_ms: 0 },
    ])
    .mockResolvedValueOnce([
      { id: 'ses_new', station_uuid: 'sta_1', ocpp_protocol: 'ocpp2.1', elapsed_ms: 30_000 },
      { id: 'ses_old', station_uuid: 'sta_1', ocpp_protocol: 'ocpp2.1', elapsed_ms: 900_000 },
    ])
    .mockResolvedValueOnce([
      {
        id: 7,
        session_token: 'tok_started',
        station_uuid: 'sta_2',
        ocpp_protocol: 'ocpp1.6',
        elapsed_ms: 10_000,
        started_session_id: 'ses_guest',
        started_token_type: 'DirectPayment',
      },
      {
        id: 8,
        session_token: 'tok_waiting',
        station_uuid: 'sta_2',
        ocpp_protocol: 'ocpp1.6',
        elapsed_ms: 100_000,
        started_session_id: null,
        started_token_type: null,
      },
    ])
    .mockResolvedValueOnce([{ charging_session_id: 'ses_guest_done' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDelayMs.mockImplementation(({ id }: { id: string }) =>
    Promise.resolve(id === 'sta_1' ? 240_000 : 120_000),
  );
});

describe('rebuildDelayedJobs', () => {
  it('re-adds every delayed job the database holds, with the time left', async () => {
    databaseRows();
    const rebuilt = await rebuildDelayedJobs(queues);

    expect(rebuilt).toEqual({
      reservationActivations: 2,
      remoteStartTimeouts: 2,
      guestStartTimeouts: 1,
      guestLinks: 1,
      guestCaptures: 1,
    });
    expect(mockEnqueueReservation.mock.calls).toEqual([
      [{ name: 'reservations' }, 'res_future', 90_000],
      [{ name: 'reservations' }, 'res_due', 0],
    ]);
    // Station timeout plus margin minus the time since the start, never below 0.
    expect(mockEnqueueTimeout.mock.calls).toEqual([
      [{ name: 'remote-start-timeouts' }, { kind: 'session', sessionId: 'ses_new' }, 210_000],
      [{ name: 'remote-start-timeouts' }, { kind: 'session', sessionId: 'ses_old' }, 0],
      [{ name: 'remote-start-timeouts' }, { kind: 'guest', guestSessionId: 8 }, 20_000],
    ]);
    // The connection timeout is read once per station.
    expect(mockDelayMs).toHaveBeenCalledTimes(2);
    expect(mockDelayMs).toHaveBeenCalledWith({ id: 'sta_1', ocppProtocol: 'ocpp2.1' });
    // A guest whose transaction started is linked, never timed out.
    expect(mockEnqueueStarted).toHaveBeenCalledWith(
      { name: 'guest-session-events' },
      {
        type: 'TransactionStarted',
        sessionId: 'ses_guest',
        idToken: { idToken: 'tok_started', type: 'DirectPayment' },
      },
    );
    expect(mockEnqueueEnded).toHaveBeenCalledWith(
      { name: 'guest-session-events' },
      'ses_guest_done',
    );
  });

  it('adds nothing when the database has nothing pending', async () => {
    mockExecute.mockResolvedValue([]);
    const rebuilt = await rebuildDelayedJobs(queues);
    expect(Object.values(rebuilt)).toEqual([0, 0, 0, 0, 0]);
    expect(mockEnqueueReservation).not.toHaveBeenCalled();
    expect(mockEnqueueTimeout).not.toHaveBeenCalled();
    mockExecute.mockReset();
  });
});

describe('recoverLostRedisState', () => {
  it('is a no-op while Redis holds every scheduler', async () => {
    mockFindMissing.mockResolvedValueOnce([]);
    const result = await recoverLostRedisState(queues, log);
    expect(result).toEqual({ missing: [], rebuilt: null });
    expect(mockScheduleCron).not.toHaveBeenCalled();
    expect(mockScheduleCoordinator).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('registers the schedulers again and rebuilds the delayed jobs when any is missing', async () => {
    mockFindMissing.mockResolvedValueOnce(['report-scheduler', 'load-management-coordinator']);
    databaseRows();
    const result = await recoverLostRedisState(queues, log);
    expect(result.missing).toEqual(['report-scheduler', 'load-management-coordinator']);
    expect(result.rebuilt?.reservationActivations).toBe(2);
    expect(mockScheduleCron).toHaveBeenCalledWith((queues as { cronQueue: unknown }).cronQueue);
    expect(mockScheduleCoordinator).toHaveBeenCalledWith(
      (queues as { loadQueue: unknown }).loadQueue,
    );
    const warn = (log as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toMatch(/schedulers missing/);
  });
});

describe('startRedisRecoveryWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks when the Redis connection becomes ready and on every interval', async () => {
    mockFindMissing.mockResolvedValue([]);
    const watch = await startRedisRecoveryWatch(queues, log, 1000);
    expect(mockFindMissing).not.toHaveBeenCalled();

    redisClient.emit('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFindMissing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFindMissing).toHaveBeenCalledTimes(2);

    await watch.stop();
    redisClient.emit('ready');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockFindMissing).toHaveBeenCalledTimes(2);
    expect(redisClient.listenerCount('ready')).toBe(0);
  });

  it('shares a running check and retries a failed one on the next tick', async () => {
    let release: (value: string[]) => void = () => {};
    mockFindMissing.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (release = resolve)),
    );
    const watch = await startRedisRecoveryWatch(queues, log, 1000);
    const first = watch.check();
    const second = watch.check();
    expect(mockFindMissing).toHaveBeenCalledTimes(1);
    release([]);
    await Promise.all([first, second]);

    mockFindMissing.mockRejectedValueOnce(new Error('Connection is closed'));
    await watch.check();
    const error = (log as { error: ReturnType<typeof vi.fn> }).error;
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Job scheduler check failed; retrying on the next tick',
    );

    mockFindMissing.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFindMissing).toHaveBeenCalledTimes(3);
    await watch.stop();
  });
});
