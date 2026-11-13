// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The operator monitor rule insert and the SetMonitoringData item
// (`variable-monitoring.ts`), and the clear outcome of a reply without a
// usable result.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({ fake: undefined as unknown as FakeDb }));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake);
});

const { insertPendingMonitorRule, setMonitoringDataItem, monitorClearOutcome } =
  await import('../variable-monitoring.js');

const rule = {
  stationId: 'sta_1',
  component: 'EVSE',
  componentInstance: null,
  variable: 'Power',
  type: 'UpperThreshold',
  value: 22,
  severity: 4,
  source: 'operator' as const,
};

beforeEach(() => h.fake.reset());

describe('insertPendingMonitorRule', () => {
  it('stores the rule pending with its value as text and returns the row', async () => {
    h.fake.queue('insert:variable_monitoring_rules', [{ id: 8, status: 'pending' }]);
    const row = await insertPendingMonitorRule(rule);
    expect(row).toEqual({ id: 8, status: 'pending' });
    expect(h.fake.find('insert', 'variable_monitoring_rules')[0]!.values).toEqual({
      ...rule,
      value: '22',
      status: 'pending',
    });
  });

  it('throws when the insert returns no row', async () => {
    await expect(insertPendingMonitorRule(rule)).rejects.toThrow(
      'Monitoring rule insert returned no row',
    );
  });
});

describe('setMonitoringDataItem', () => {
  it('names the instance and the id to replace only when set', () => {
    expect(setMonitoringDataItem({ ...rule, componentInstance: 'M1', value: '-90' }, 41)).toEqual({
      id: 41,
      component: { name: 'EVSE', instance: 'M1' },
      variable: { name: 'Power' },
      type: 'UpperThreshold',
      value: -90,
      severity: 4,
    });
    expect(setMonitoringDataItem({ ...rule, value: '22' })).toEqual({
      component: { name: 'EVSE' },
      variable: { name: 'Power' },
      type: 'UpperThreshold',
      value: 22,
      severity: 4,
    });
  });
});

describe('monitorClearOutcome', () => {
  it('is failed for a send error, and rejected with the status and reason', () => {
    expect(monitorClearOutcome({ error: 'Station offline' } as never, 1)).toEqual({
      kind: 'failed',
      timedOut: false,
      errorInfo: 'Station offline',
    });
    expect(
      monitorClearOutcome(
        {
          response: {
            clearMonitoringResult: [
              { id: 2, status: 'Rejected', statusInfo: { reasonCode: 'ReadOnly' } },
            ],
          },
        } as never,
        2,
      ),
    ).toEqual({ kind: 'rejected', errorInfo: 'Rejected: ReadOnly' });
    expect(
      monitorClearOutcome(
        {
          response: {
            clearMonitoringResult: [
              {
                id: 2,
                status: 'Rejected',
                statusInfo: { reasonCode: 'ReadOnly', additionalInfo: 'Built in' },
              },
            ],
          },
        } as never,
        2,
      ),
    ).toEqual({ kind: 'rejected', errorInfo: 'Rejected: ReadOnly (Built in)' });
  });
});
