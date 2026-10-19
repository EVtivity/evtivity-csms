// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: { execute: vi.fn(() => Promise.resolve([])) },
  PNC_SETTINGS_CACHE_TTL_MS: 60_000,
  OCPP_SETTINGS_CACHE_TTL_MS: 90_000,
}));

vi.mock('drizzle-orm', () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'),
    values,
  })),
}));

import { db } from '@evtivity/database';
import { OCTT_PENDING_RESTORE_SETTING_KEY } from '@evtivity/lib';
import {
  PENDING_RESTORE_HEARTBEAT_MS,
  PendingSettingsRestore,
  restoreLeftoverRunSettings,
  settingsCacheTtlMs,
} from '../run-settings.js';

type Query = { text: string; values: unknown[] };
const queries = (): Query[] =>
  vi.mocked(db.execute).mock.calls.map((call) => call[0] as unknown as Query);
const logger = { warn: vi.fn() };

describe('settingsCacheTtlMs', () => {
  it('waits for the longest cache among the keys', () => {
    expect(settingsCacheTtlMs(['pnc.enabled'])).toBe(60_000);
    expect(settingsCacheTtlMs(['smartCharging.iso15118Enabled'])).toBe(90_000);
    expect(settingsCacheTtlMs(['pnc.enabled', 'smartCharging.iso15118Enabled'])).toBe(90_000);
    expect(settingsCacheTtlMs(['ocpp.heartbeatInterval'])).toBe(90_000);
  });

  it('assumes the longest cache for a key no known cache reads', () => {
    expect(settingsCacheTtlMs(['pricing.splitBillingEnabled'])).toBe(90_000);
  });

  it('needs no wait without keys', () => {
    expect(settingsCacheTtlMs([])).toBe(0);
  });
});

describe('PendingSettingsRestore', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset();
    vi.mocked(db.execute).mockResolvedValue([] as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps case changes ahead of run changes in the row, so a replay ends at the values before the run', async () => {
    const pending = new PendingSettingsRestore(logger);
    await pending.record('run', { key: 'smartCharging.iso15118Enabled', previous: false });
    await pending.record('case', { key: 'smartCharging.iso15118Enabled', previous: true });
    await pending.record('case', { key: 'pnc.provider', previous: undefined });
    pending.stopHeartbeat();

    const last = queries().at(-1);
    expect(last?.values).toEqual([
      OCTT_PENDING_RESTORE_SETTING_KEY,
      JSON.stringify({
        changes: [
          { key: 'smartCharging.iso15118Enabled', previous: true },
          { key: 'pnc.provider', unset: true },
          { key: 'smartCharging.iso15118Enabled', previous: false },
        ],
      }),
      expect.any(String),
    ]);
  });

  it('keeps every change in the row when a restore fails', async () => {
    const pending = new PendingSettingsRestore(logger);
    await pending.record('run', { key: 'pnc.enabled', previous: false });
    await pending.record('case', { key: 'smartCharging.iso15118Enabled', previous: true });
    vi.mocked(db.execute).mockClear();
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('database gone'));

    await expect(pending.restoreAll()).rejects.toThrow('Restoring the run settings failed');
    // The run restore still ran; the row was not removed.
    expect(queries().map((q) => q.values.at(-1))).toEqual([
      'smartCharging.iso15118Enabled',
      'pnc.enabled',
    ]);

    vi.mocked(db.execute).mockClear();
    await pending.restoreAll();
    expect(queries().at(-1)?.text).toContain('DELETE FROM settings');
    expect(queries().at(-1)?.values).toEqual([OCTT_PENDING_RESTORE_SETTING_KEY]);
  });

  it('writes nothing when the run changed nothing', async () => {
    const pending = new PendingSettingsRestore(logger);
    await pending.restoreAll();
    expect(queries()).toEqual([]);
  });

  it('refreshes the row while the run goes on, and stops when it ends', async () => {
    vi.useFakeTimers();
    const pending = new PendingSettingsRestore(logger);
    await pending.record('run', { key: 'pnc.enabled', previous: false });
    vi.mocked(db.execute).mockClear();

    await vi.advanceTimersByTimeAsync(PENDING_RESTORE_HEARTBEAT_MS);
    expect(queries().map((q) => q.text)).toEqual([
      'UPDATE settings SET updated_at = now() WHERE key = ?',
    ]);

    await pending.restoreAll();
    vi.mocked(db.execute).mockClear();
    await vi.advanceTimersByTimeAsync(PENDING_RESTORE_HEARTBEAT_MS * 2);
    expect(queries()).toEqual([]);
  });

  it('logs a failed refresh and keeps going', async () => {
    vi.useFakeTimers();
    const pending = new PendingSettingsRestore(logger);
    await pending.record('run', { key: 'pnc.enabled', previous: false });
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(PENDING_RESTORE_HEARTBEAT_MS);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Refreshing the pending settings restore row failed',
    );
    pending.stopHeartbeat();
  });

  it('drops a discarded change from the row', async () => {
    const pending = new PendingSettingsRestore(logger);
    const ca = { key: 'pnc.local.caEnc', previous: undefined };
    await pending.record('run', ca);
    await pending.discard(ca);
    expect(queries().at(-1)?.text).toContain('DELETE FROM settings');
    await pending.restoreAll();
    expect(queries().filter((q) => q.values.includes('pnc.local.caEnc'))).toEqual([]);
  });
});

describe('restoreLeftoverRunSettings', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset();
    vi.mocked(db.execute).mockResolvedValue([] as never);
    logger.warn.mockClear();
  });

  it('does nothing without a row', async () => {
    await expect(restoreLeftoverRunSettings(logger)).resolves.toEqual([]);
    expect(queries()).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reads only a row older than staleBefore when given', async () => {
    const staleBefore = new Date('2026-10-19T10:00:00Z');
    await restoreLeftoverRunSettings(logger, { staleBefore });
    const select = queries()[0];
    const condition = select?.values[1] as Query;
    expect(condition.text).toContain('updated_at <');
    expect(condition.values).toEqual([staleBefore.toISOString()]);
  });

  it('skips malformed entries and restores the rest', async () => {
    const value = { changes: [{ key: 'pnc.enabled', previous: false }, { previous: 1 }, 'x'] };
    vi.mocked(db.execute).mockResolvedValueOnce([{ value }] as never);
    const restored = await restoreLeftoverRunSettings(logger);
    expect(restored).toEqual([{ key: 'pnc.enabled', previous: false }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { restored: ['pnc.enabled'] },
      'Restored the settings an earlier conformance run left changed',
    );
  });
});
