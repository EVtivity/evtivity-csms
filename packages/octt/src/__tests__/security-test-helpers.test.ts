// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { waitForEvse } from '../security-test-helpers.js';
import type { TestContext } from '../types.js';

/** The CSMS lists the EVSE only after `pollsUntilCreated` reads, as the StatusNotification projection does. */
function makeContext(pollsUntilCreated: number): {
  ctx: TestContext;
  callApi: ReturnType<typeof vi.fn>;
} {
  let polls = 0;
  const callApi = vi.fn((_method: string, _path: string) => {
    polls++;
    const body = polls >= pollsUntilCreated ? [{ evseId: 1, connectors: [] }] : [];
    return Promise.resolve({ status: 200, body });
  });
  return {
    callApi,
    ctx: {
      client: {} as TestContext['client'],
      stationId: 'OCTT-C-authorization-TC_C_131_CSMS-test',
      tokens: {} as TestContext['tokens'],
      stationDbId: 'sta_test',
      logger: pino({ level: 'silent' }),
      config: { serverUrl: 'ws://localhost:7103' },
      callApi: callApi as unknown as TestContext['callApi'],
    },
  };
}

describe('waitForEvse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits until the CSMS created the EVSE row', async () => {
    vi.useFakeTimers();
    const { ctx, callApi } = makeContext(4);
    const wait = waitForEvse(ctx, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await wait).toBeNull();
    expect(callApi).toHaveBeenCalledWith('GET', '/stations/sta_test/connectors');
    expect(callApi).toHaveBeenCalledTimes(4);
  });

  it('reports the EVSE that never appeared', async () => {
    vi.useFakeTimers();
    const { ctx } = makeContext(Number.POSITIVE_INFINITY);
    const wait = waitForEvse(ctx, 1, 2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await wait).toBe('EVSE 1 not known to the CSMS within 2 s (HTTP 200)');
  });
});
