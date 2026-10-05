// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  newTransactionId,
  startStationSequence,
  waitForStationSequence,
} from '../csms-test-helpers.js';

describe('newTransactionId', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('differs for tests that start in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T06:23:38.273Z'));
    const ids = new Set(Array.from({ length: 50 }, () => newTransactionId('OCTT-TX')));
    expect(ids.size).toBe(50);
  });

  it('keeps the prefix and fits CiString36 for the longest prefix', () => {
    const id = newTransactionId('UNKNOWN-TX');
    expect(id).toMatch(/^UNKNOWN-TX-\d{13}-[0-9a-f]{6}$/);
    expect(id.length).toBeLessThanOrEqual(36);
  });
});

describe('station sequences', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a slow sequence instead of a fixed time', async () => {
    vi.useFakeTimers();
    const sequence = startStationSequence(
      () => new Promise<void>((resolve) => setTimeout(resolve, 7_000)),
    );
    let result: string | null | undefined;
    void waitForStationSequence(sequence).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(result).toBeNull();
  });

  it('reports a failed call of the sequence', async () => {
    vi.useFakeTimers();
    const sequence = startStationSequence(() => Promise.reject(new Error('CALL timeout')), 0);
    const wait = waitForStationSequence(sequence);
    await vi.advanceTimersByTimeAsync(100);
    expect(await wait).toBe('Station sequence failed: CALL timeout');
  });

  it('gives up after the bound with a clear message', async () => {
    vi.useFakeTimers();
    const sequence = startStationSequence(() => new Promise<void>(() => {}), 0);
    const wait = waitForStationSequence(sequence, 2_000);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await wait).toBe('Station sequence not finished within 2 s');
  });

  it('says so when the CSMS request that starts the sequence never came', async () => {
    expect(await waitForStationSequence(null)).toBe(
      'Station sequence not started (no ResetRequest received)',
    );
  });
});
