// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const h = vi.hoisted(() => ({
  delay: vi.fn(),
  publish: vi.fn(),
  rows: [] as unknown[],
  selectError: null as Error | null,
}));

vi.mock('@evtivity/database', () => ({
  REMOTE_START_TIMEOUT_CHANNEL: 'remote_start_timeout',
  remoteStartTimeoutDelayMs: h.delay,
  chargingStations: { id: 'st.id', stationId: 'st.station_id', ocppProtocol: 'st.ocpp_protocol' },
  guestSessions: { id: 'gs.id', stationOcppId: 'gs.station_ocpp_id', sessionToken: 'gs.token' },
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => (h.selectError != null ? Promise.reject(h.selectError) : h.rows),
        }),
      }),
    }),
  },
}));
vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish: h.publish }) }));

import {
  scheduleGuestStartTimeout,
  scheduleRemoteStartTimeout,
} from '../lib/remote-start-timeout.js';

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.selectError = null;
  h.delay.mockResolvedValue(240_000);
  h.publish.mockResolvedValue(undefined);
});

describe('scheduleRemoteStartTimeout', () => {
  it('publishes the session with the delay of its station', async () => {
    await scheduleRemoteStartTimeout(
      { kind: 'session', sessionId: 'ses_1' },
      { id: 'sta_1', ocppProtocol: 'ocpp1.6' },
      log,
    );
    expect(h.delay).toHaveBeenCalledWith({ id: 'sta_1', ocppProtocol: 'ocpp1.6' });
    expect(h.publish).toHaveBeenCalledWith(
      'remote_start_timeout',
      JSON.stringify({ kind: 'session', sessionId: 'ses_1', delayMs: 240_000 }),
    );
  });

  it('logs and does not throw when the publish fails (fail-open)', async () => {
    h.publish.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      scheduleRemoteStartTimeout(
        { kind: 'session', sessionId: 'ses_1' },
        { id: 'sta_1', ocppProtocol: 'ocpp2.1' },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'session', sessionId: 'ses_1' } }),
      'Failed to schedule the remote start timeout',
    );
  });
});

describe('scheduleGuestStartTimeout', () => {
  it('publishes the guest session id, never its token', async () => {
    h.rows = [{ guestSessionId: 301, stationUuid: 'sta_2', ocppProtocol: 'ocpp2.1' }];
    await scheduleGuestStartTimeout('secret-token', log);
    expect(h.delay).toHaveBeenCalledWith({ id: 'sta_2', ocppProtocol: 'ocpp2.1' });
    const [, payload] = h.publish.mock.calls[0] as [string, string];
    expect(JSON.parse(payload)).toEqual({ kind: 'guest', guestSessionId: 301, delayMs: 240_000 });
    expect(payload).not.toContain('secret-token');
  });

  it('does nothing for an unknown token', async () => {
    await scheduleGuestStartTimeout('unknown', log);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('logs and does not throw when the lookup fails', async () => {
    h.selectError = new Error('db down');
    await expect(scheduleGuestStartTimeout('tok', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to schedule the guest start timeout',
    );
  });
});
