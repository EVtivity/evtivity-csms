// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { setJobQueueResolver } from '@evtivity/lib/job-queues';
import { STATION_WATCH_QUEUE } from '@evtivity/lib/worker-queues';
import {
  STATION_WATCH_JOB_NAME,
  alertStationWatchersIfAvailable,
  claimStationWatches,
  findDueStationWatch,
} from '../lib/station-watch.js';
import { availableEvseCountSql } from '../lib/driver-availability.js';

interface Call {
  text: string;
  values: unknown[];
}

let calls: Call[] = [];
let results: unknown[][] = [];

function createSqlMock(): postgres.Sql {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(results.shift() ?? []);
  };
  (sqlFn as unknown as Record<string, unknown>)['unsafe'] = (text: string) => text;
  return sqlFn as unknown as postgres.Sql;
}

describe('station watch alerts', () => {
  let sql: postgres.Sql;
  const add = vi.fn();
  const queueNames: string[] = [];

  beforeEach(() => {
    calls = [];
    results = [];
    sql = createSqlMock();
    add.mockReset().mockResolvedValue(undefined);
    queueNames.length = 0;
    setJobQueueResolver((name) => {
      queueNames.push(name);
      return { add, addBulk: vi.fn() };
    });
  });

  afterEach(() => {
    setJobQueueResolver(null);
  });

  it('finds a due alert only for a watched station with a free EVSE by the shared rule', async () => {
    results = [[{ station_id: 'CS-1' }]];
    expect(await findDueStationWatch(sql, 'sta_1')).toBe('CS-1');
    expect(calls[0]?.text).toContain('FROM station_watches w');
    expect(calls[0]?.text).toContain('w.expires_at > now()');
    expect(calls[0]?.values).toContain(availableEvseCountSql('cs'));
    expect(calls[0]?.values).toContain('sta_1');
  });

  it('adds the station-watch dispatch job to the worker queue when an alert is due', async () => {
    results = [[{ station_id: 'CS-1' }]];
    expect(await alertStationWatchersIfAvailable(sql, 'sta_1')).toBe(true);
    expect(queueNames).toEqual([STATION_WATCH_QUEUE]);
    // No job id: the claim makes a duplicate job a no-op.
    expect(add).toHaveBeenCalledWith(STATION_WATCH_JOB_NAME, { stationId: 'CS-1' });
  });

  it('adds nothing when the station is not free or not watched', async () => {
    results = [[]];
    expect(await alertStationWatchersIfAvailable(sql, 'sta_1')).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('throws when the job cannot be added, so the caller logs it', async () => {
    results = [[{ station_id: 'CS-1' }]];
    add.mockRejectedValueOnce(new Error('redis down'));
    await expect(alertStationWatchersIfAvailable(sql, 'sta_1')).rejects.toThrow('redis down');
  });

  it('claims the watches in one statement only while the station is free', async () => {
    results = [[{ driver_id: 'drv_1' }, { driver_id: 'drv_2' }]];
    expect(await claimStationWatches(sql, 'CS-1')).toEqual(['drv_1', 'drv_2']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('DELETE FROM station_watches');
    expect(calls[0]?.text).toContain('RETURNING w.driver_id');
    expect(calls[0]?.values).toContain(availableEvseCountSql('cs'));
  });
});
