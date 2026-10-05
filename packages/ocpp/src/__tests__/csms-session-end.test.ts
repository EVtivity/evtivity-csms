// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import type { EventBus, Logger, PubSubClient } from '@evtivity/lib';
const { mockCancelOpenSessionHold } = vi.hoisted(() => ({
  mockCancelOpenSessionHold: vi.fn(),
}));
vi.mock('@evtivity/payments', () => ({ cancelOpenSessionHold: mockCancelOpenSessionHold }));
vi.mock('../lib/payments.js', () => ({ paymentContext: () => ({ registry: 'registry' }) }));

import {
  giveUpSessionEnd,
  requestCsmsSessionEnd,
  startSessionEndSweep,
  subscribeSessionEndRequests,
  sweepSessionEndRequests,
  SESSION_ENDED_BY_CSMS,
} from '../server/csms-session-end.js';

function makeSql(rows: Record<string, unknown>[]): {
  sql: postgres.Sql;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

function makeBus(): EventBus & { publish: ReturnType<typeof vi.fn> } {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    drain: vi.fn(),
    track: <T>(work: Promise<T>) => work,
  };
}

const claimedRow = {
  transaction_id: 'tx-1',
  updated_at: new Date('2026-06-01T01:00:00Z'),
  station_ocpp_id: 'CS-001',
  next_seq_no: '3',
};

describe('requestCsmsSessionEnd', () => {
  it('claims an active session and publishes an Ended-shaped CSMS end at its last update', async () => {
    const { sql, calls } = makeSql([claimedRow]);
    const bus = makeBus();

    expect(await requestCsmsSessionEnd(sql, bus, 'ses_1', 'GhostRecovered')).toBe(true);

    const text = calls[0]?.text ?? '';
    expect(text).toContain('SET stopped_reason = ?');
    expect(text).toContain('end_request_reason = ?');
    expect(text).toContain('end_claimed_at = now()');
    expect(text).toContain("cs.status = 'active'");
    expect(text).toContain('cs.end_claimed_at IS NULL');
    expect(text).toContain('end_attempts = cs.end_attempts + 1');
    expect(text).toContain('cs.end_attempts < ?');
    expect(calls[0]?.values).toEqual(['GhostRecovered', 'GhostRecovered', 'ses_1', 5, 300]);
    expect(bus.publish).toHaveBeenCalledWith({
      eventType: SESSION_ENDED_BY_CSMS,
      aggregateType: 'Transaction',
      aggregateId: 'tx-1',
      payload: {
        eventType: 'Ended',
        stationId: 'CS-001',
        transactionId: 'tx-1',
        seqNo: 3,
        triggerReason: 'AbnormalCondition',
        timestamp: '2026-06-01T01:00:00.000Z',
        stoppedReason: 'GhostRecovered',
      },
    });
  });

  it('publishes nothing when the session is not active or already claimed', async () => {
    const { sql } = makeSql([]);
    const bus = makeBus();
    expect(await requestCsmsSessionEnd(sql, bus, 'ses_1', 'Superseded')).toBe(false);
    expect(bus.publish).not.toHaveBeenCalled();
  });
});

describe('subscribeSessionEndRequests', () => {
  async function subscribed(rows: Record<string, unknown>[]) {
    let handler: ((raw: string) => void) | null = null;
    const pubsub = {
      subscribe: vi.fn((_channel: string, cb: (raw: string) => void) => {
        handler = cb;
        return Promise.resolve({ unsubscribe: vi.fn() });
      }),
    } as unknown as PubSubClient;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
      warn: ReturnType<typeof vi.fn>;
    };
    const bus = makeBus();
    await subscribeSessionEndRequests(pubsub, makeSql(rows).sql, bus, logger);
    expect(pubsub.subscribe).toHaveBeenCalledWith('session_end_requests', expect.any(Function));
    return { send: (raw: string) => handler?.(raw), bus, logger };
  }

  it('ends the requested session', async () => {
    const { send, bus } = await subscribed([claimedRow]);
    send(JSON.stringify({ sessionId: 'ses_1', reason: 'GhostRecovered' }));
    await vi.waitFor(() => {
      expect(bus.publish).toHaveBeenCalledTimes(1);
    });
  });

  it('logs and ignores a malformed request', async () => {
    const { send, bus, logger } = await subscribed([claimedRow]);
    send(JSON.stringify({ sessionId: 'ses_1', reason: 'StaleSession' }));
    send('not json');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(bus.publish).not.toHaveBeenCalled();
  });
});

describe('sweepSessionEndRequests', () => {
  /** The pending-request query answers `pending`; every claim answers `claims`. */
  function sweepSql(
    pending: Record<string, unknown>[],
    claims: Record<string, unknown>[],
  ): { sql: postgres.Sql; calls: string[] } {
    const calls: string[] = [];
    const fn = (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      calls.push(text);
      return Promise.resolve(text.includes('SELECT id, end_request_reason') ? pending : claims);
    };
    return { sql: fn as unknown as postgres.Sql, calls };
  }
  const makeLogger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

  it('ends each pending request nobody holds a lease on', async () => {
    const { sql, calls } = sweepSql(
      [
        { id: 'ses_1', end_request_reason: 'GhostRecovered' },
        { id: 'ses_2', end_request_reason: 'Superseded' },
      ],
      [claimedRow],
    );
    const bus = makeBus();
    expect(await sweepSessionEndRequests(sql, bus, makeLogger() as unknown as Logger)).toBe(2);
    expect(calls[0]).toContain("status = 'active'");
    expect(calls[0]).toContain('end_request_reason IS NOT NULL');
    expect(calls[0]).toContain('end_claimed_at IS NULL');
    expect(bus.publish).toHaveBeenCalledTimes(2);
  });

  it('skips an unknown reason and a request another pod claimed', async () => {
    const { sql } = sweepSql(
      [
        { id: 'ses_1', end_request_reason: 'Other' },
        { id: 'ses_2', end_request_reason: 'GhostRecovered' },
      ],
      [],
    );
    const bus = makeBus();
    const log = makeLogger();
    expect(await sweepSessionEndRequests(sql, bus, log as unknown as Logger)).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('runs on an interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      const { sql, calls } = sweepSql([], []);
      const stop = startSessionEndSweep(sql, makeBus(), makeLogger() as unknown as Logger, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(calls).toHaveLength(2);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('giving up on a session end', () => {
  function giveUpSql(faultRows: Record<string, unknown>[]): {
    sql: postgres.Sql;
    calls: Array<{ text: string; values: unknown[] }>;
  } {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('SELECT id, end_request_reason')) {
        return Promise.resolve([
          { id: 'ses_1', end_request_reason: 'GhostRecovered', end_attempts: 5 },
        ]);
      }
      return Promise.resolve(text.includes("SET status = 'faulted'") ? faultRows : []);
    };
    const helpers = fn as unknown as Record<string, unknown>;
    helpers['json'] = (value: unknown) => value;
    return { sql: fn as unknown as postgres.Sql, calls };
  }
  const makeLogger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

  it('faults the session unbilled after the cap, cancels its hold, and logs at error', async () => {
    mockCancelOpenSessionHold.mockReset().mockResolvedValue({ status: 'cancelled' });
    const { sql, calls } = giveUpSql([{ id: 'ses_1' }]);
    const bus = makeBus();
    const log = makeLogger();

    expect(await sweepSessionEndRequests(sql, bus, log as unknown as Logger)).toBe(0);

    const fault = calls.find((c) => c.text.includes("SET status = 'faulted'"));
    expect(fault?.text).toContain('final_cost_cents = 0');
    expect(fault?.values).toContain('EndRequestFailed');
    expect(calls.some((c) => c.text.includes('UPDATE session_tariff_segments'))).toBe(true);
    expect(mockCancelOpenSessionHold).toHaveBeenCalledWith('ses_1', 'Session end failed', {
      registry: 'registry',
    });
    expect(log.error).toHaveBeenCalledWith(
      { sessionId: 'ses_1', attempts: 5 },
      'Session end failed repeatedly; session faulted unbilled and its hold cancelled',
    );
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('leaves a session that ended meanwhile alone (P5)', async () => {
    mockCancelOpenSessionHold.mockReset();
    const { sql } = giveUpSql([]);
    expect(await giveUpSessionEnd(sql, 'ses_1', makeLogger() as unknown as Logger)).toBe(false);
    expect(mockCancelOpenSessionHold).not.toHaveBeenCalled();
  });

  it('logs a warning when the hold cancel fails (fail-open)', async () => {
    mockCancelOpenSessionHold.mockReset().mockRejectedValue(new Error('provider down'));
    const { sql } = giveUpSql([{ id: 'ses_1' }]);
    const log = makeLogger();
    expect(await giveUpSessionEnd(sql, 'ses_1', log as unknown as Logger)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'Failed to cancel the hold of a session whose end failed',
    );
  });
});
