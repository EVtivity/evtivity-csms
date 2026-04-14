// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

// Mock the database config module to prevent postgres from connecting at module load
vi.mock('../../../../packages/database/src/config.ts', () => ({
  db: {},
  client: vi.fn(),
}));

// Mock database exports
vi.mock('@evtivity/database', () => {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of [
      'values',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'where',
      'from',
      'limit',
      'set',
      'returning',
    ]) {
      chain[m] = vi.fn(self);
    }
    chain['then'] = (resolve?: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
    return chain;
  };
  const chain = makeChain();
  return {
    db: {
      insert: vi.fn(() => chain),
      delete: vi.fn(() => chain),
      select: vi.fn(() => chain),
      update: vi.fn(() => chain),
      execute: vi.fn(() => Promise.resolve([])),
    },
    client: vi.fn(),
    chargingStations: { id: 'id', stationId: 'station_id' },
    drivers: { id: 'id', email: 'email' },
    driverTokens: { id: 'id', driverId: 'driver_id' },
    refreshTokens: { id: 'id' },
    users: { id: 'id' },
    pricingGroups: { id: 'id' },
    tariffs: { id: 'id' },
    pricingGroupDrivers: { id: 'id' },
  };
});

vi.mock('@evtivity/database/src/lib/id.js', () => ({
  createId: vi.fn(() => 'mock_id'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  like: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(
    vi.fn(() => ''),
    { raw: vi.fn(() => '') },
  ),
}));

vi.mock('../executor.js', () => ({
  executeTest: vi.fn(async (tc: { id: string; name: string; module: string; version: string }) => ({
    testId: tc.id,
    testName: tc.name,
    module: tc.module,
    version: tc.version,
    result: {
      status: 'passed' as const,
      durationMs: 50,
      steps: [],
    },
  })),
}));

vi.mock('../registry.js', () => ({
  getRegistry: vi.fn(() => [
    {
      id: 'TC_B_01_CSMS',
      name: 'Boot Notification',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    },
    {
      id: 'TC_B_02_CSMS',
      name: 'Boot Notification Rejected',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    },
    {
      id: 'TC_E_01_CSMS',
      name: 'Transaction Start',
      module: 'E-transactions',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'test',
      purpose: 'test',
      execute: vi.fn(),
    },
  ]),
}));

vi.mock('../api-client.js', () => ({
  createApiClient: vi.fn(() => ({
    createApiKey: vi.fn().mockResolvedValue({ id: 1, key: 'test-key' }),
    deleteApiKey: vi.fn().mockResolvedValue(undefined),
    triggerCommand: vi.fn().mockResolvedValue({ status: 'Accepted' }),
  })),
}));

import { runTests } from '../runner.js';

describe('runTests', () => {
  const config = {
    serverUrl: 'ws://localhost:3003',
    version: 'ocpp2.1' as const,
    concurrency: 2,
    provisionStations: false,
  };

  it('runs all matching tests and returns summary', async () => {
    const results: Array<{ testId: string }> = [];
    const summary = await runTests(config, (r) => results.push(r));

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(results).toHaveLength(3);
  });

  it('filters by module when specified', async () => {
    const results: Array<{ module: string }> = [];
    const summary = await runTests({ ...config, module: 'B-provisioning' }, (r) => results.push(r));

    expect(summary.total).toBe(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.module === 'B-provisioning')).toBe(true);
  });

  it('calls onResult callback for each test', async () => {
    const onResult = vi.fn();
    await runTests(config, onResult);
    expect(onResult).toHaveBeenCalledTimes(3);
  });
});
