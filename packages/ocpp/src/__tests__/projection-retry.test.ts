// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@evtivity/database', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
}));

const { PROJECTION_RETRY_DEFAULTS, projectionRetryDelayMs, runProjectionWithRetry } =
  await import('../server/projection-retry.js');

function connectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} localhost:5433`), { code });
}

const OPTIONS = { ...PROJECTION_RETRY_DEFAULTS, random: () => 0.5 };

// Runs the projection and lets every backoff elapse.
async function run(
  work: Parameters<typeof runProjectionWithRetry>[0],
  options: Parameters<typeof runProjectionWithRetry>[1] = OPTIONS,
): Promise<unknown> {
  const outcome = runProjectionWithRetry(work, options).then(
    () => null,
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(60_000);
  return outcome;
}

describe('projectionRetryDelayMs', () => {
  it('doubles per retry with equal jitter, capped', () => {
    const opts = { baseDelayMs: 500, maxDelayMs: 1500 };
    expect(projectionRetryDelayMs(1, opts, () => 0)).toBe(250);
    expect(projectionRetryDelayMs(1, opts, () => 0.999999)).toBe(500);
    expect(projectionRetryDelayMs(2, opts, () => 0)).toBe(500);
    expect(projectionRetryDelayMs(2, opts, () => 0.999999)).toBe(1000);
    expect(projectionRetryDelayMs(3, opts, () => 0.999999)).toBe(1500);
  });
});

describe('runProjectionWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once when the projection succeeds', async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    expect(await run(work)).toBeNull();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs again after a lost connection, after the backoff', async () => {
    const onRetry = vi.fn();
    const work = vi
      .fn()
      .mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'))
      .mockResolvedValueOnce(undefined);

    const outcome = runProjectionWithRetry(work, { ...OPTIONS, onRetry });
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(1);
    // random 0.5: 250 + 0.5 * 250 = 375 ms before the first retry.
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 375 }));
    await vi.advanceTimersByTimeAsync(374);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(work).toHaveBeenCalledTimes(2);
    expect(work.mock.calls.map((c) => (c[0] as { number: number }).number)).toEqual([1, 2]);
  });

  it('throws the last error after maxAttempts runs', async () => {
    const work = vi.fn().mockRejectedValue(connectionError('ECONNREFUSED'));
    const err = await run(work);
    expect((err as { code?: string }).code).toBe('ECONNREFUSED');
    expect(work).toHaveBeenCalledTimes(3);
    // Only the last run allowed is marked last.
    expect(work.mock.calls.map((c) => (c[0] as { isLast: boolean }).isLast)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('never retries an error that is not a lost connection', async () => {
    for (const err of [
      Object.assign(new Error('duplicate key'), { code: '23505' }),
      new Error('bad data'),
      connectionError('CONNECTION_ENDED'),
    ]) {
      const work = vi.fn().mockRejectedValue(err);
      expect(await run(work)).toBe(err);
      expect(work).toHaveBeenCalledTimes(1);
    }
  });

  it('runs once with maxAttempts 1', async () => {
    const work = vi.fn().mockRejectedValue(connectionError('CONNECT_TIMEOUT'));
    await run(work, { ...OPTIONS, maxAttempts: 1 });
    expect(work).toHaveBeenCalledTimes(1);
    expect((work.mock.calls[0]?.[0] as { isLast: boolean }).isLast).toBe(true);
  });

  it('once: a succeeded step is not run again, and a retry gets its result', async () => {
    const insert = vi.fn().mockResolvedValue({ count: 1 });
    const results: unknown[] = [];
    let attempt = 0;
    await run(async (a) => {
      results.push(await a.once('insert', insert));
      attempt++;
      if (attempt === 1) throw connectionError('CONNECT_TIMEOUT');
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ count: 1 }, { count: 1 }]);
  });

  it('once: a step that never reached the server runs again', async () => {
    const insert = vi
      .fn()
      .mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'))
      .mockResolvedValueOnce({ count: 1 });
    expect(await run((a) => a.once('insert', insert).then(() => undefined))).toBeNull();
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('once: a step interrupted mid-statement may have committed, so nothing is retried', async () => {
    const interrupted = connectionError('ECONNRESET');
    const insert = vi.fn().mockRejectedValue(interrupted);
    const err = await run((a) => a.once('insert', insert).then(() => undefined));
    expect(err).toBe(interrupted);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('memo: an interrupted idempotent step runs again, and its result is kept', async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(connectionError('CONNECTION_CLOSED'))
      .mockResolvedValueOnce('was offline');
    const later = vi
      .fn()
      .mockRejectedValueOnce(connectionError('CONNECT_TIMEOUT'))
      .mockResolvedValueOnce(undefined);
    const seen: unknown[] = [];
    expect(
      await run(async (a) => {
        seen.push(await a.memo('update', update));
        await later();
      }),
    ).toBeNull();
    expect(update).toHaveBeenCalledTimes(2);
    expect(later).toHaveBeenCalledTimes(2);
    // Attempt 1 failed in the update, attempt 2 ran it and failed later, attempt 3 reused it.
    expect(seen).toEqual(['was offline', 'was offline']);
  });

  it('an interrupted statement outside once is retried', async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(connectionError('57P01'))
      .mockResolvedValueOnce(undefined);
    expect(await run(work)).toBeNull();
    expect(work).toHaveBeenCalledTimes(2);
  });
});
