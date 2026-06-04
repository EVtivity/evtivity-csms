// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import type { PubSubClient } from '../pubsub.js';
import type { StationMessageContext } from '../station-message.js';

const mockRenderStationMessage = vi.fn();
vi.mock('../station-message.js', () => ({
  renderStationMessage: (...args: unknown[]) => mockRenderStationMessage(...args),
}));

let uuidCounter = 0;
vi.mock('node:crypto', () => ({
  default: {
    randomUUID: () => `uuid-${String(++uuidCounter)}`,
  },
}));

import { clearStationMessage, dispatchOneShotStationMessage } from '../station-message-dispatch.js';

interface SqlMock {
  sql: Sql;
  setProtocol: (protocol: string | null | undefined) => void;
  setThrow: (err: Error) => void;
  calls: unknown[][];
}

function createSqlMock(): SqlMock {
  let rows: unknown[] = [];
  let toThrow: Error | null = null;
  const calls: unknown[][] = [];

  const sqlFn = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    calls.push(values);
    if (toThrow != null) return Promise.reject(toThrow);
    return Promise.resolve(rows);
  };

  return {
    sql: sqlFn as unknown as Sql,
    setProtocol: (protocol) => {
      toThrow = null;
      rows = protocol === undefined ? [{}] : [{ ocpp_protocol: protocol }];
    },
    setThrow: (err) => {
      toThrow = err;
    },
    calls,
  };
}

function createPubSubMock(): { pubsub: PubSubClient; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn().mockResolvedValue(undefined);
  const pubsub = {
    publish,
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as PubSubClient;
  return { pubsub, publish };
}

const baseContext: StationMessageContext = {
  companyName: 'EVtivity',
  stationOcppId: 'CS-1234',
};

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  mockRenderStationMessage.mockReset();
});

describe('clearStationMessage', () => {
  it('returns false when the protocol lookup query throws', async () => {
    const { sql, setThrow } = createSqlMock();
    setThrow(new Error('db down'));
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns false when no protocol is on file (null row value)', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol(null);
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns false when the row has no ocpp_protocol field', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol(undefined);
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('passes the stationDbId to the protocol lookup query', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    const { pubsub } = createPubSubMock();

    await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_abc',
    });

    expect(sqlMock.calls).toHaveLength(1);
    expect(sqlMock.calls[0]).toEqual(['sta_abc']);
  });

  it('publishes ClearDisplayMessage on ocpp2.1 with default slot 9010', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-9',
      stationDbId: 'sta_9',
    });

    expect(result).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(payload)).toEqual({
      commandId: 'uuid-1',
      stationId: 'CS-9',
      action: 'ClearDisplayMessage',
      payload: { id: 9010 },
      version: 'ocpp2.1',
    });
  });

  it('publishes ClearDisplayMessage on ocpp2.0.1 (any ocpp2 prefix)', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.0.1');
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-9',
      stationDbId: 'sta_9',
    });

    expect(result).toBe(true);
    const [, payload] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(payload)).toMatchObject({
      action: 'ClearDisplayMessage',
      version: 'ocpp2.0.1',
    });
  });

  it('honors a custom slotId on the ocpp2.1 clear', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    const { pubsub, publish } = createPubSubMock();

    await clearStationMessage(
      pubsub,
      sqlMock.sql,
      { stationOcppId: 'CS-9', stationDbId: 'sta_9' },
      { slotId: 9020 },
    );

    const [, payload] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(payload).payload).toEqual({ id: 9020 });
  });

  it('publishes a vendor DataTransfer on ocpp1.6 with default messageId', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp1.6');
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-16',
      stationDbId: 'sta_16',
    });

    expect(result).toBe(true);
    const [channel, payload] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(payload)).toEqual({
      commandId: 'uuid-1',
      stationId: 'CS-16',
      action: 'DataTransfer',
      payload: {
        vendorId: 'com.evtivity',
        messageId: 'ClearOneShotMessage',
        data: JSON.stringify({ slotId: 9010 }),
      },
      version: 'ocpp1.6',
    });
  });

  it('honors a custom dataTransferMessageId and slotId on the ocpp1.6 clear', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp1.6');
    const { pubsub, publish } = createPubSubMock();

    await clearStationMessage(
      pubsub,
      sqlMock.sql,
      { stationOcppId: 'CS-16', stationDbId: 'sta_16' },
      { slotId: 9030, dataTransferMessageId: 'CustomClear' },
    );

    const [, payload] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(payload).payload).toEqual({
      vendorId: 'com.evtivity',
      messageId: 'CustomClear',
      data: JSON.stringify({ slotId: 9030 }),
    });
  });

  it('returns false for an unsupported protocol without publishing', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp0');
    const { pubsub, publish } = createPubSubMock();

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-0',
      stationDbId: 'sta_0',
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns false when publish throws on the ocpp2.1 path', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    const { pubsub, publish } = createPubSubMock();
    publish.mockRejectedValueOnce(new Error('redis down'));

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-9',
      stationDbId: 'sta_9',
    });

    expect(result).toBe(false);
  });

  it('returns false when publish throws on the ocpp1.6 path', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp1.6');
    const { pubsub, publish } = createPubSubMock();
    publish.mockRejectedValueOnce(new Error('redis down'));

    const result = await clearStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-16',
      stationDbId: 'sta_16',
    });

    expect(result).toBe(false);
  });
});

describe('dispatchOneShotStationMessage', () => {
  it('returns false when the protocol lookup query throws', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setThrow(new Error('db down'));
    const { pubsub, publish } = createPubSubMock();

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(mockRenderStationMessage).not.toHaveBeenCalled();
  });

  it('returns false when no protocol is on file', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol(null);
    const { pubsub, publish } = createPubSubMock();

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(mockRenderStationMessage).not.toHaveBeenCalled();
  });

  it('returns false when rendering throws', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    mockRenderStationMessage.mockRejectedValueOnce(new Error('no template'));
    const { pubsub, publish } = createPubSubMock();

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns false when the rendered content is empty', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    mockRenderStationMessage.mockResolvedValueOnce('');
    const { pubsub, publish } = createPubSubMock();

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('renders the requested state with the supplied context', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
    const { pubsub } = createPubSubMock();

    await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-1',
      stationDbId: 'sta_1',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(mockRenderStationMessage).toHaveBeenCalledTimes(1);
    expect(mockRenderStationMessage).toHaveBeenCalledWith('payment_failed', baseContext);
  });

  it('publishes SetDisplayMessage on ocpp2.1 with default slot/priority/ttl', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
    const { pubsub, publish } = createPubSubMock();

    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-21',
      stationDbId: 'sta_21',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(payload)).toEqual({
      commandId: 'uuid-1',
      stationId: 'CS-21',
      action: 'SetDisplayMessage',
      payload: {
        message: {
          id: 9010,
          priority: 'AlwaysFront',
          message: { format: 'UTF8', content: 'Payment declined' },
          endDateTime: new Date(fixedNow + 30 * 1000).toISOString(),
        },
      },
      version: 'ocpp2.1',
    });

    vi.restoreAllMocks();
  });

  it('applies custom slotId, priority, and ttlSeconds on the ocpp2.1 path', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.0.1');
    mockRenderStationMessage.mockResolvedValueOnce('Authorize required');
    const { pubsub, publish } = createPubSubMock();

    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    await dispatchOneShotStationMessage(
      pubsub,
      sqlMock.sql,
      {
        stationOcppId: 'CS-21',
        stationDbId: 'sta_21',
        state: 'unauthorized',
        context: baseContext,
      },
      { slotId: 9099, priority: 'InFront', ttlSeconds: 60 },
    );

    const [, payload] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(payload)).toMatchObject({
      action: 'SetDisplayMessage',
      version: 'ocpp2.0.1',
      payload: {
        message: {
          id: 9099,
          priority: 'InFront',
          message: { format: 'UTF8', content: 'Authorize required' },
          endDateTime: new Date(fixedNow + 60 * 1000).toISOString(),
        },
      },
    });

    vi.restoreAllMocks();
  });

  it('publishes a vendor DataTransfer on ocpp1.6 with default messageId', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp1.6');
    mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
    const { pubsub, publish } = createPubSubMock();

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-16',
      stationDbId: 'sta_16',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(true);
    const [channel, payload] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(payload)).toEqual({
      commandId: 'uuid-1',
      stationId: 'CS-16',
      action: 'DataTransfer',
      payload: {
        vendorId: 'com.evtivity',
        messageId: 'OneShotMessage',
        data: JSON.stringify({ state: 'payment_failed', message: 'Payment declined' }),
      },
      version: 'ocpp1.6',
    });
  });

  it('honors a custom dataTransferMessageId on the ocpp1.6 path', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp1.6');
    mockRenderStationMessage.mockResolvedValueOnce('Hi');
    const { pubsub, publish } = createPubSubMock();

    await dispatchOneShotStationMessage(
      pubsub,
      sqlMock.sql,
      {
        stationOcppId: 'CS-16',
        stationDbId: 'sta_16',
        state: 'payment_required',
        context: baseContext,
      },
      { dataTransferMessageId: 'CustomSet' },
    );

    const [, payload] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(payload).payload).toMatchObject({ messageId: 'CustomSet' });
  });

  it('returns false for an unsupported protocol after rendering, without publishing', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp0');
    mockRenderStationMessage.mockResolvedValueOnce('Some content');
    const { pubsub, publish } = createPubSubMock();

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-0',
      stationDbId: 'sta_0',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns false when publish throws on the ocpp2.1 path', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp2.1');
    mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
    const { pubsub, publish } = createPubSubMock();
    publish.mockRejectedValueOnce(new Error('redis down'));

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-21',
      stationDbId: 'sta_21',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
  });

  it('returns false when publish throws on the ocpp1.6 path', async () => {
    const sqlMock = createSqlMock();
    sqlMock.setProtocol('ocpp1.6');
    mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
    const { pubsub, publish } = createPubSubMock();
    publish.mockRejectedValueOnce(new Error('redis down'));

    const result = await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
      stationOcppId: 'CS-16',
      stationDbId: 'sta_16',
      state: 'payment_failed',
      context: baseContext,
    });

    expect(result).toBe(false);
  });

  describe('autoClear scheduling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules a clear that fires after autoClearMs and unrefs the timer', async () => {
      const sqlMock = createSqlMock();
      sqlMock.setProtocol('ocpp2.1');
      mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
      const { pubsub, publish } = createPubSubMock();

      const unrefSpy = vi.fn();
      let capturedCb: (() => void) | undefined;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
        capturedCb = fn as () => void;
        return { unref: unrefSpy } as unknown as NodeJS.Timeout;
      });

      const result = await dispatchOneShotStationMessage(
        pubsub,
        sqlMock.sql,
        {
          stationOcppId: 'CS-21',
          stationDbId: 'sta_21',
          state: 'payment_failed',
          context: baseContext,
        },
        { autoClearMs: 30_000 },
      );

      expect(result).toBe(true);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
      // The initial dispatch published once. The clear has not fired yet.
      expect(publish).toHaveBeenCalledTimes(1);

      // Fire the captured callback to exercise the scheduled clear.
      sqlMock.setProtocol('ocpp2.1');
      capturedCb?.();
      await vi.waitFor(() => {
        expect(publish).toHaveBeenCalledTimes(2);
      });

      const [, clearPayload] = publish.mock.calls[1] as [string, string];
      expect(JSON.parse(clearPayload)).toMatchObject({
        action: 'ClearDisplayMessage',
        payload: { id: 9010 },
      });

      vi.restoreAllMocks();
    });

    it('uses the custom slotId and dataTransferClearMessageId in the scheduled clear', async () => {
      const sqlMock = createSqlMock();
      sqlMock.setProtocol('ocpp1.6');
      mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
      const { pubsub, publish } = createPubSubMock();

      let captured: (() => void) | undefined;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
        captured = fn as () => void;
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      });

      await dispatchOneShotStationMessage(
        pubsub,
        sqlMock.sql,
        {
          stationOcppId: 'CS-16',
          stationDbId: 'sta_16',
          state: 'payment_failed',
          context: baseContext,
        },
        { autoClearMs: 5000, slotId: 9077, dataTransferClearMessageId: 'CustomClear' },
      );

      sqlMock.setProtocol('ocpp1.6');
      captured?.();
      await vi.waitFor(() => {
        expect(publish).toHaveBeenCalledTimes(2);
      });

      const [, clearPayload] = publish.mock.calls[1] as [string, string];
      expect(JSON.parse(clearPayload).payload).toEqual({
        vendorId: 'com.evtivity',
        messageId: 'CustomClear',
        data: JSON.stringify({ slotId: 9077 }),
      });

      vi.restoreAllMocks();
    });

    it('does not schedule a clear when autoClearMs is not provided', async () => {
      const sqlMock = createSqlMock();
      sqlMock.setProtocol('ocpp2.1');
      mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
      const { pubsub } = createPubSubMock();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await dispatchOneShotStationMessage(pubsub, sqlMock.sql, {
        stationOcppId: 'CS-21',
        stationDbId: 'sta_21',
        state: 'payment_failed',
        context: baseContext,
      });

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('does not schedule a clear when autoClearMs is zero', async () => {
      const sqlMock = createSqlMock();
      sqlMock.setProtocol('ocpp2.1');
      mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
      const { pubsub } = createPubSubMock();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await dispatchOneShotStationMessage(
        pubsub,
        sqlMock.sql,
        {
          stationOcppId: 'CS-21',
          stationDbId: 'sta_21',
          state: 'payment_failed',
          context: baseContext,
        },
        { autoClearMs: 0 },
      );

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('does not schedule a clear when the dispatch was not published', async () => {
      const sqlMock = createSqlMock();
      sqlMock.setProtocol('ocpp0');
      mockRenderStationMessage.mockResolvedValueOnce('Some content');
      const { pubsub } = createPubSubMock();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const result = await dispatchOneShotStationMessage(
        pubsub,
        sqlMock.sql,
        {
          stationOcppId: 'CS-0',
          stationDbId: 'sta_0',
          state: 'payment_failed',
          context: baseContext,
        },
        { autoClearMs: 30_000 },
      );

      expect(result).toBe(false);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('tolerates a timer without an unref method', async () => {
      const sqlMock = createSqlMock();
      sqlMock.setProtocol('ocpp2.1');
      mockRenderStationMessage.mockResolvedValueOnce('Payment declined');
      const { pubsub } = createPubSubMock();

      vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
        return {} as unknown as NodeJS.Timeout;
      });

      const result = await dispatchOneShotStationMessage(
        pubsub,
        sqlMock.sql,
        {
          stationOcppId: 'CS-21',
          stationDbId: 'sta_21',
          state: 'payment_failed',
          context: baseContext,
        },
        { autoClearMs: 30_000 },
      );

      expect(result).toBe(true);
      vi.restoreAllMocks();
    });
  });
});
