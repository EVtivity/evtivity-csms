// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

const db = vi.hoisted(() => ({
  enabled: vi.fn<() => Promise<boolean>>(),
  read: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  isCsmsUpdateCheckEnabled: db.enabled,
  readCsmsUpdateCheck: db.read,
  recordCsmsUpdateCheck: db.record,
}));

import {
  CSMS_UPDATE_CHECK_STARTUP_JOB_ID,
  csmsUpdateCheckHandler,
  fetchLatestCsmsVersion,
  queueCsmsUpdateCheckAtStartup,
} from '../../handlers/csms-update-check.js';

function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function reply(body: string, init: { status?: number; type?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/plain; charset=utf-8' },
  });
}

const NOW = new Date('2026-11-10T03:41:00Z');

describe('csmsUpdateCheckHandler', () => {
  beforeEach(() => {
    db.enabled.mockReset().mockResolvedValue(true);
    db.read.mockReset().mockResolvedValue(null);
    db.record.mockReset().mockResolvedValue(undefined);
  });

  it('fetches nothing while the update check is off', async () => {
    db.enabled.mockResolvedValue(false);
    const fetchFn = vi.fn();
    const outcome = await csmsUpdateCheckHandler(makeLog(), fetchFn, () => NOW);
    expect(outcome).toEqual({ status: 'off' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(db.record).not.toHaveBeenCalled();
  });

  it('reads the version file once and stores the stable version', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('v0.1.51\n'));
    const outcome = await csmsUpdateCheckHandler(makeLog(), fetchFn, () => NOW);
    expect(outcome).toEqual({ status: 'checked', latestVersion: '0.1.51' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://evtivity.com/csms-version.txt');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // No cookie, credential or install detail goes to the website.
    expect(init.headers).toEqual({ accept: 'text/plain' });
    expect(db.record).toHaveBeenCalledWith('0.1.51', NOW);
  });

  it('skips a run within a day of the last try', async () => {
    db.read.mockResolvedValue({
      latestVersion: '0.1.50',
      checkedAt: new Date('2026-11-09T20:00:00Z'),
      attemptedAt: new Date('2026-11-09T20:00:00Z'),
    });
    const fetchFn = vi.fn();
    const outcome = await csmsUpdateCheckHandler(makeLog(), fetchFn, () => NOW);
    expect(outcome).toEqual({ status: 'skipped' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('runs again a day after the last try', async () => {
    db.read.mockResolvedValue({
      latestVersion: '0.1.50',
      checkedAt: new Date('2026-11-09T03:41:00Z'),
      attemptedAt: new Date('2026-11-09T03:41:00Z'),
    });
    const fetchFn = vi.fn().mockResolvedValue(reply('v0.1.51'));
    const outcome = await csmsUpdateCheckHandler(makeLog(), fetchFn, () => NOW);
    expect(outcome.status).toBe('checked');
  });

  it('keeps the last known version on a failed read and records the try', async () => {
    const log = makeLog();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const outcome = await csmsUpdateCheckHandler(log, fetchFn, () => NOW);
    expect(outcome).toEqual({ status: 'failed', reason: 'TypeError' });
    expect(db.record).toHaveBeenCalledWith(null, NOW);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('fetchLatestCsmsVersion', () => {
  it('refuses an error status, a reply that is not plain text and a reply that is no version', async () => {
    await expect(
      fetchLatestCsmsVersion(vi.fn().mockResolvedValue(reply('x', { status: 503 }))),
    ).resolves.toEqual({ reason: 'status_503' });
    await expect(
      fetchLatestCsmsVersion(
        vi.fn().mockResolvedValue(reply('<html>v0.1.51</html>', { type: 'text/html' })),
      ),
    ).resolves.toEqual({ reason: 'not_text' });
    await expect(
      fetchLatestCsmsVersion(vi.fn().mockResolvedValue(reply('v0.1.51-beta.1'))),
    ).resolves.toEqual({ reason: 'not_a_version' });
  });

  it('refuses a reply over the size cap unread', async () => {
    await expect(
      fetchLatestCsmsVersion(vi.fn().mockResolvedValue(reply('v0.1.51'.padEnd(1000, ' ')))),
    ).rejects.toThrow();
  });
});

describe('queueCsmsUpdateCheckAtStartup', () => {
  beforeEach(() => {
    db.enabled.mockReset().mockResolvedValue(true);
    db.read.mockReset().mockResolvedValue(null);
    db.record.mockReset().mockResolvedValue(undefined);
  });

  it('queues one job under the fixed start-up id when the check is due', async () => {
    db.read.mockResolvedValue({
      latestVersion: '0.1.50',
      checkedAt: new Date('2026-11-09T03:00:00Z'),
      attemptedAt: new Date('2026-11-09T03:00:00Z'),
    });
    const add = vi.fn().mockResolvedValue({});
    const outcome = await queueCsmsUpdateCheckAtStartup({ add }, makeLog(), () => NOW);
    expect(outcome).toBe('queued');
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'csms-update-check',
      {},
      { jobId: CSMS_UPDATE_CHECK_STARTUP_JOB_ID, removeOnComplete: true, removeOnFail: true },
    );
  });

  it('queues the first check when no try is stored', async () => {
    const add = vi.fn().mockResolvedValue({});
    expect(await queueCsmsUpdateCheckAtStartup({ add }, makeLog(), () => NOW)).toBe('queued');
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('queues nothing within 23 hours of the stored last try', async () => {
    db.read.mockResolvedValue({
      latestVersion: null,
      checkedAt: null,
      attemptedAt: new Date('2026-11-09T05:00:00Z'),
    });
    const add = vi.fn();
    const outcome = await queueCsmsUpdateCheckAtStartup({ add }, makeLog(), () => NOW);
    expect(outcome).toBe('not_due');
    expect(add).not.toHaveBeenCalled();
  });

  it('queues and reads nothing while the update check is off', async () => {
    db.enabled.mockResolvedValue(false);
    const add = vi.fn();
    const outcome = await queueCsmsUpdateCheckAtStartup({ add }, makeLog(), () => NOW);
    expect(outcome).toBe('off');
    expect(add).not.toHaveBeenCalled();
    expect(db.read).not.toHaveBeenCalled();
  });

  it('never throws: a failed read or queue add is logged at warn', async () => {
    const log = makeLog();
    db.read.mockRejectedValueOnce(new Error('db down'));
    expect(await queueCsmsUpdateCheckAtStartup({ add: vi.fn() }, log, () => NOW)).toBe('failed');
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    expect(await queueCsmsUpdateCheckAtStartup({ add }, log, () => NOW)).toBe('failed');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('logs a fetch error of the start-up run and stops nothing', async () => {
    const log = makeLog();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    let run: Promise<unknown> | undefined;
    const add = vi.fn(() => {
      run = csmsUpdateCheckHandler(log, fetchFn, () => NOW);
      return Promise.resolve({});
    });
    expect(await queueCsmsUpdateCheckAtStartup({ add }, log, () => NOW)).toBe('queued');
    await expect(run).resolves.toEqual({ status: 'failed', reason: 'TypeError' });
    expect(db.record).toHaveBeenCalledWith(null, NOW);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
