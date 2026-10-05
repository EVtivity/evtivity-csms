// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { TestContext } from '../types.js';

const tryConnect = vi.hoisted(() => vi.fn<() => Promise<number>>());

vi.mock('../security-test-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security-test-helpers.js')>()),
  tryConnect,
}));

const { TC_A_19_CSMS } = await import('../tests/v2_1/csms/A-security/TC_A_19_CSMS.js');

type IncomingHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** A CSMS that upgrades the station to profile 2 the way the station-security service does. */
function makeContext(serverUrl: string, tlsServerUrl: string): TestContext {
  let handler: IncomingHandler | null = null;
  let onConnected: (() => void) | null = null;
  const client = {
    protocol: 'ocpp2.1',
    isConnected: true,
    sendCall: vi.fn(() => Promise.resolve({ status: 'Accepted' })),
    setIncomingCallHandler: vi.fn((h: IncomingHandler) => {
      handler = h;
    }),
    setConnectedHandler: vi.fn((h: () => void) => {
      onConnected = h;
    }),
    setDisconnectedHandler: vi.fn(),
    updateConnection: vi.fn(),
    simulateConnectionLoss: vi.fn(() => {
      onConnected?.();
    }),
  };
  const callApi = vi.fn(async (method: string) => {
    if (method === 'GET') return { status: 200, body: { isOnline: true } };
    if (handler == null) throw new Error('no incoming handler');
    await handler('m1', 'SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        messageTimeout: 30,
        ocppInterface: 'Wired0',
        ocppTransport: 'JSON',
        ocppVersion: 'OCPP20',
        securityProfile: 2,
        ocppCsmsUrl: tlsServerUrl,
      },
    });
    await handler('m2', 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
          attributeValue: '2,1',
        },
      ],
    });
    await handler('m3', 'Reset', { type: 'OnIdle' });
    return { status: 200, body: { pendingSecurityProfile: 2 } };
  });
  return {
    client: client as unknown as TestContext['client'],
    stationId: 'OCTT-A-security-TC_A_19_CSMS-test',
    tokens: {} as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl, tlsServerUrl },
    callApi,
  };
}

describe('TC_A_19_CSMS step 10 (A05.FR.07)', () => {
  beforeEach(() => {
    tryConnect.mockReset();
  });

  it('checks the profile 1 reconnect through a plain ws:// endpoint', async () => {
    tryConnect.mockResolvedValue(401);
    const result = await TC_A_19_CSMS.execute(
      makeContext('ws://ocpp.example:7103', 'wss://ocpp.example:7443'),
    );
    expect(result.steps.find((s) => s.step === 10)?.status).toBe('passed');
    expect(result.status).toBe('passed');
  });

  it('fails when the CSMS still accepts profile 1 after the upgrade', async () => {
    tryConnect.mockResolvedValue(101);
    const result = await TC_A_19_CSMS.execute(
      makeContext('ws://ocpp.example:7103', 'wss://ocpp.example:7443'),
    );
    expect(result.steps.find((s) => s.step === 10)).toMatchObject({
      status: 'failed',
      actual: 'HTTP 101',
    });
    expect(result.status).toBe('failed');
  });

  it('skips the step when --server is wss://, where Basic Auth is a valid profile 2 connection', async () => {
    const result = await TC_A_19_CSMS.execute(
      makeContext('wss://ocpp.dev.example', 'wss://ocpp.dev.example'),
    );
    expect(tryConnect).not.toHaveBeenCalled();
    expect(result.steps.find((s) => s.step === 10)).toMatchObject({
      status: 'skipped',
      expected: 'Run with --server <plain ws:// url>',
    });
    expect(result.steps.find((s) => s.step === 7)?.status).toBe('passed');
    expect(result.status).toBe('passed');
  });
});
