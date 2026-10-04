// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockRecord, redisInstances, redisListeners } = vi.hoisted(() => ({
  mockRecord: vi.fn(),
  redisInstances: [] as Array<{ url: string; options: unknown }>,
  redisListeners: [] as string[],
}));

vi.mock('@evtivity/payments', () => ({ recordProcessWatch: mockRecord }));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(url: string, options: unknown) {
      redisInstances.push({ url, options });
    }
    get(): Promise<null> {
      return Promise.resolve(null);
    }
    on(event: string): this {
      redisListeners.push(event);
      return this;
    }
  },
}));

import { processVersionWatchHandler } from '../../handlers/process-version-watch.js';

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  mockRecord.mockReset();
});

describe('processVersionWatchHandler', () => {
  it('records the watch through one Redis client and logs old processes at info', async () => {
    mockRecord.mockResolvedValue({
      check: { legacy: 2, hosts: ['10.0.0.7'] },
      state: { checkedAt: 'now', legacySeenAt: 'now' },
    });
    const log = makeLog();

    await processVersionWatchHandler(log);
    await processVersionWatchHandler(log);

    expect(redisInstances).toHaveLength(1);
    expect(redisListeners).toEqual(['error']);
    expect(redisInstances[0]?.options).toEqual({ maxRetriesPerRequest: 2 });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      { legacyConnections: 2, hosts: ['10.0.0.7'] },
      'Processes older than v0.1.38 are connected to the database',
    );
  });

  it('logs at debug when no old process is connected', async () => {
    mockRecord.mockResolvedValue({
      check: { legacy: 0, hosts: [] },
      state: { checkedAt: 'now', legacySeenAt: null },
    });
    const log = makeLog();
    await processVersionWatchHandler(log);
    expect(log.debug).toHaveBeenCalledWith('No process older than v0.1.38 is connected');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs a failure at warn and does not throw', async () => {
    const err = new Error('redis down');
    mockRecord.mockRejectedValue(err);
    const log = makeLog();
    await expect(processVersionWatchHandler(log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      { err },
      'Process version watch failed: selecting Adyen stays refused until a run succeeds',
    );
  });
});
