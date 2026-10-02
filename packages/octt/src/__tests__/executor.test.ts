// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { executeTest } from '../executor.js';
import type { TestCase, RunConfig } from '../types.js';
import pino from 'pino';

// Mock database to avoid real DB connections in unit tests
vi.mock('@evtivity/database', () => {
  const mockChain: Record<string, unknown> = {};
  const methods = ['values', 'onConflictDoNothing', 'where', 'from', 'limit', 'select'];
  for (const m of methods) {
    mockChain[m] = vi.fn(() => mockChain);
  }
  mockChain['then'] = (resolve?: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return {
    db: {
      insert: vi.fn(() => mockChain),
      delete: vi.fn(() => mockChain),
      select: vi.fn(() => mockChain),
    },
    chargingStations: { id: 'id', stationId: 'station_id' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@evtivity/database/src/lib/id.js', () => ({
  createId: vi.fn(() => 'sta_mock123'),
}));

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  sendCall: vi.fn().mockResolvedValue({ status: 'Accepted' }),
  setIncomingCallHandler: vi.fn(),
  setConnectedHandler: vi.fn(),
  setDisconnectedHandler: vi.fn(),
  get isConnected() {
    return true;
  },
  get stationId() {
    return 'OCTT-TEST';
  },
  get protocol() {
    return 'ocpp2.1' as const;
  },
};

vi.mock('../client.js', () => ({
  createTestClient: vi.fn(() => mockClient),
  generateStationId: vi.fn(() => 'OCTT-B-TC01-abc123'),
}));

const { tokens, provisionTestTokens, stopOpenTransactions } = vi.hoisted(() => ({
  tokens: {
    valid: 'OCTTAAAAAAAAAAV1',
    valid2: 'OCTTAAAAAAAAAAV2',
    masterpass: 'OCTTAAAAAAAAAAMP',
    blocked: 'OCTTAAAAAAAAAABL',
    expired: 'OCTTAAAAAAAAAAEX',
    prepaid: 'OCTTAAAAAAAAAAPP',
    noCredit: 'OCTTAAAAAAAAAANC',
  },
  provisionTestTokens: vi.fn().mockResolvedValue(undefined),
  stopOpenTransactions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../test-tokens.js', () => ({
  generateTestTokens: vi.fn(() => tokens),
  provisionTestTokens,
}));

vi.mock('../transaction-teardown.js', () => ({ stopOpenTransactions }));

const logger = pino({ level: 'silent' });

describe('executeTest', () => {
  const config: RunConfig = {
    serverUrl: 'ws://localhost:3003',
    version: 'ocpp2.1',
    concurrency: 1,
  };

  it('returns passed result for a passing test', async () => {
    const testCase: TestCase = {
      id: 'TC_B_01_CSMS',
      name: 'Boot Notification',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'Test boot notification',
      purpose: 'Verify CSMS accepts boot',
      execute: async (ctx) => {
        const res = await ctx.client.sendCall('BootNotification', {
          chargingStation: { model: 'OCTT', vendorName: 'OCTT' },
          reason: 'PowerUp',
        });
        return {
          status: res['status'] === 'Accepted' ? 'passed' : 'failed',
          durationMs: 50,
          steps: [
            {
              step: 1,
              description: 'Send BootNotification',
              status: res['status'] === 'Accepted' ? 'passed' : 'failed',
              expected: 'Accepted',
              actual: String(res['status']),
            },
          ],
        };
      },
    };

    const result = await executeTest(testCase, config, logger);
    expect(result.testId).toBe('TC_B_01_CSMS');
    expect(result.result.status).toBe('passed');
    expect(result.result.steps).toHaveLength(1);
  });

  it('returns error result when test throws', async () => {
    const testCase: TestCase = {
      id: 'TC_FAIL',
      name: 'Failing test',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'This test throws',
      purpose: 'Test error handling',
      execute: async () => {
        throw new Error('Connection refused');
      },
    };

    const result = await executeTest(testCase, config, logger);
    expect(result.testId).toBe('TC_FAIL');
    expect(result.result.status).toBe('error');
    expect(result.result.error).toBe('Connection refused');
  });

  it('disconnects client after test completes', async () => {
    const testCase: TestCase = {
      id: 'TC_DISC',
      name: 'Disconnect test',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'Test disconnect',
      purpose: 'Verify cleanup',
      execute: async () => ({
        status: 'passed',
        durationMs: 10,
        steps: [],
      }),
    };

    await executeTest(testCase, config, logger);
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('stops open transactions before disconnecting, also when the test throws', async () => {
    stopOpenTransactions.mockClear();
    const testCase: TestCase = {
      id: 'TC_TEARDOWN',
      name: 'Teardown test',
      module: 'E-transactions',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'Test teardown',
      purpose: 'Verify transactions are stopped',
      execute: async () => {
        throw new Error('boom');
      },
    };

    await executeTest(testCase, config, logger);
    expect(stopOpenTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        client: mockClient,
        stationId: 'OCTT-B-TC01-abc123',
        stationDbId: 'sta_mock123',
        version: 'ocpp2.1',
      }),
    );
  });

  it('provisions per-test tokens for the test driver and exposes them as ctx.tokens', async () => {
    provisionTestTokens.mockClear();
    let seen: unknown;
    const testCase: TestCase = {
      id: 'TC_TOKENS',
      name: 'Tokens test',
      module: 'C-authorization',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'Test tokens',
      purpose: 'Verify tokens',
      execute: async (ctx) => {
        seen = ctx.tokens;
        return { status: 'passed', durationMs: 0, steps: [] };
      },
    };

    await executeTest(testCase, config, logger, undefined, undefined, 'drv_1');
    expect(provisionTestTokens).toHaveBeenCalledWith('drv_1', tokens);
    expect(seen).toBe(tokens);
  });

  it('does not provision tokens without a test driver', async () => {
    provisionTestTokens.mockClear();
    const testCase: TestCase = {
      id: 'TC_NO_DRIVER',
      name: 'No driver',
      module: 'C-authorization',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'No driver',
      purpose: 'No driver',
      execute: async () => ({ status: 'passed', durationMs: 0, steps: [] }),
    };

    await executeTest(testCase, config, logger);
    expect(provisionTestTokens).not.toHaveBeenCalled();
  });

  it('default handler answers SetVariables and GetVariables per request item', async () => {
    mockClient.setIncomingCallHandler.mockClear();
    const testCase: TestCase = {
      id: 'TC_DEFAULT_HANDLER',
      name: 'Default handler',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'Default handler',
      purpose: 'Default handler',
      execute: async () => ({ status: 'passed', durationMs: 0, steps: [] }),
    };
    await executeTest(testCase, config, logger);

    const handler = mockClient.setIncomingCallHandler.mock.calls[0]?.[0] as (
      id: string,
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const component = { name: 'OCPPCommCtrlr' };
    const variable = { name: 'HeartbeatInterval' };
    await expect(
      handler('m1', 'SetVariables', {
        setVariableData: [{ attributeValue: '60', component, variable }],
      }),
    ).resolves.toEqual({
      setVariableResult: [{ attributeStatus: 'Accepted', component, variable }],
    });
    await expect(
      handler('m2', 'GetVariables', {
        getVariableData: [{ attributeType: 'Actual', component, variable }],
      }),
    ).resolves.toEqual({
      getVariableResult: [
        { attributeType: 'Actual', attributeStatus: 'UnknownComponent', component, variable },
      ],
    });
    await expect(handler('m3', 'ClearVariableMonitoring', { id: [3, 4] })).resolves.toEqual({
      clearMonitoringResult: [
        { id: 3, status: 'Accepted' },
        { id: 4, status: 'Accepted' },
      ],
    });
  });
});
