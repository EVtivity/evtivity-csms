// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface MockSubscription {
  unsubscribe: () => Promise<void>;
}
type SubscribeFn = (channel: string, cb: (raw: string) => void) => Promise<MockSubscription>;

const { publishMock, subscribeMock, executeMock } = vi.hoisted(() => ({
  publishMock: vi.fn(async (_channel: string, _payload: string): Promise<void> => undefined),
  subscribeMock: vi.fn<SubscribeFn>(),
  executeMock: vi.fn(),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: publishMock, subscribe: subscribeMock }),
}));

vi.mock('@evtivity/database', () => ({
  db: { execute: executeMock },
}));

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

import { triggerAndWaitForStatus } from '../lib/station-status-check.js';

const unsubscribeMock = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  unsubscribeMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('triggerAndWaitForStatus', () => {
  function makeRow(status: string, updatedAt: string): { status: string; updated_at: string } {
    return { status, updated_at: updatedAt };
  }

  it('returns Connector not found when the before-row is missing', async () => {
    executeMock.mockResolvedValueOnce([]); // before SELECT
    const result = await triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp1.6');
    expect(result).toEqual({ status: null, errorCode: 'CONNECTOR_NOT_FOUND' });
  });

  it('returns an error when the command fails (no station response)', async () => {
    executeMock.mockResolvedValueOnce([makeRow('Available', '2026-06-04T00:00:00Z')]);
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      // Never deliver a matching result; force the inner timeout path quickly.
      void cb;
      return { unsubscribe: unsubscribeMock };
    });
    vi.useFakeTimers();
    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp1.6');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await promise;
    expect(result).toEqual({ status: null, errorCode: 'STATION_TIMEOUT' });
  });

  it('returns an error when the station rejects the status check', async () => {
    executeMock.mockResolvedValueOnce([makeRow('Available', '2026-06-04T00:00:00Z')]);
    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });
    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp1.6');
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalled();
    });
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
    };
    ref.handler?.(JSON.stringify({ commandId: sent.commandId, response: { status: 'Rejected' } }));
    const result = await promise;
    expect(result).toEqual({ status: null, errorCode: 'STATUS_CHECK_REJECTED' });
  });

  it('returns the current DB status when the station replies NotImplemented', async () => {
    executeMock.mockResolvedValueOnce([makeRow('Charging', '2026-06-04T00:00:00Z')]);
    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });
    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp1.6');
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalled();
    });
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
    };
    ref.handler?.(
      JSON.stringify({ commandId: sent.commandId, response: { status: 'NotImplemented' } }),
    );
    const result = await promise;
    expect(result).toEqual({ status: 'Charging' });
  });

  it('polls the DB and returns the new status once updated_at advances', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T00:00:00Z'));
    // before SELECT
    executeMock.mockResolvedValueOnce([makeRow('Available', '2026-06-04T00:00:00Z')]);
    // poll SELECT returns an advanced updated_at
    executeMock.mockResolvedValueOnce([makeRow('Occupied', '2026-06-04T00:00:10Z')]);

    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp1.6');
    await vi.advanceTimersByTimeAsync(0);
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
    };
    ref.handler?.(JSON.stringify({ commandId: sent.commandId, response: { status: 'Accepted' } }));

    // First poll fires after STATUS_POLL_INTERVAL_MS (500ms).
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;
    expect(result).toEqual({ status: 'Occupied' });
  });

  it('times out polling when updated_at never advances', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T00:00:00Z'));
    executeMock.mockResolvedValueOnce([makeRow('Available', '2026-06-04T00:00:00Z')]);
    // Every poll returns the same (un-advanced) updated_at.
    executeMock.mockResolvedValue([makeRow('Available', '2026-06-04T00:00:00Z')]);

    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp1.6');
    await vi.advanceTimersByTimeAsync(0);
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
    };
    ref.handler?.(JSON.stringify({ commandId: sent.commandId, response: { status: 'Accepted' } }));

    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;
    expect(result).toEqual({ status: null, errorCode: 'STATUS_CHECK_TIMEOUT' });
  });

  it('uses a TransactionEvent trigger for OCPP 2.1 stations with an active session', async () => {
    executeMock
      .mockResolvedValueOnce([makeRow('Occupied', '2026-06-04T00:00:00Z')]) // before
      .mockResolvedValueOnce([{ id: 'ses_1' }]); // active session lookup

    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp2.1');
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalled();
    });
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
      payload: Record<string, unknown>;
    };
    expect(sent.payload['requestedMessage']).toBe('TransactionEvent');
    expect(sent.payload['evse']).toEqual({ id: 1, connectorId: 1 });

    ref.handler?.(
      JSON.stringify({ commandId: sent.commandId, response: { status: 'NotImplemented' } }),
    );
    const result = await promise;
    expect(result).toEqual({ status: 'Occupied' });
  });

  it('uses a StatusNotification trigger for OCPP 2.1 stations with no active session', async () => {
    executeMock
      .mockResolvedValueOnce([makeRow('Available', '2026-06-04T00:00:00Z')]) // before
      .mockResolvedValueOnce([]); // no active session

    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    subscribeMock.mockImplementation(async (_c: string, cb: (raw: string) => void) => {
      ref.handler = cb;
      return { unsubscribe: unsubscribeMock };
    });

    const promise = triggerAndWaitForStatus('CS-1', 1, 1, 'sta_1', 'ocpp2.1');
    await vi.waitFor(() => {
      expect(publishMock).toHaveBeenCalled();
    });
    const sent = JSON.parse((publishMock.mock.calls[0] as [string, string])[1]) as {
      commandId: string;
      payload: Record<string, unknown>;
    };
    expect(sent.payload['requestedMessage']).toBe('StatusNotification');
    expect(sent.payload['evse']).toEqual({ id: 1, connectorId: 1 });

    ref.handler?.(
      JSON.stringify({ commandId: sent.commandId, response: { status: 'NotImplemented' } }),
    );
    const result = await promise;
    expect(result).toEqual({ status: 'Available' });
  });
});
