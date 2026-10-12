// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, type Mock } from 'vitest';
import pino from 'pino';
import type { CallApiFn, TestContext } from '../types.js';
import { TC_B_100_CSMS } from '../tests/v2_1/csms/B-provisioning/TC_B_100_CSMS.js';

type IncomingHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const SERVER_URL = 'ws://ocpp.example:7103';
const STATION_ID = 'OCTT-B-provisioning-TC_B_100_CSMS';

/**
 * A CSMS that upgrades the station from profile 0 to 1 the way the
 * station-security service does, sending `extra` in the connection data.
 */
function makeContext(extra: (password: string) => Record<string, unknown>): {
  ctx: TestContext;
  callApi: Mock<CallApiFn>;
} {
  let handler: IncomingHandler | null = null;
  const client = {
    protocol: 'ocpp2.1',
    isConnected: true,
    sendCall: vi.fn(() => Promise.resolve({ status: 'Accepted' })),
    setIncomingCallHandler: vi.fn((h: IncomingHandler) => {
      handler = h;
    }),
  };
  const callApi = vi.fn<CallApiFn>(async (method, _path, body) => {
    if (method === 'GET') return { status: 200, body: { isOnline: true } };
    if (handler == null) throw new Error('no incoming handler');
    const vars = await handler('m0', 'GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'NetworkConfigurationPriority' },
        },
      ],
    });
    const result = (vars['getVariableResult'] as { attributeValue?: string }[])[0];
    expect(result?.attributeValue).toBe('1');
    await handler('m1', 'SetNetworkProfile', {
      configurationSlot: 2,
      connectionData: {
        ocppVersion: 'OCPP20',
        ocppInterface: 'Wired0',
        ocppTransport: 'JSON',
        messageTimeout: 30,
        ocppCsmsUrl: SERVER_URL,
        securityProfile: 1,
        ...extra(String(body?.['password'])),
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
    return { status: 200, body: { pendingSecurityProfile: 1 } };
  });
  const ctx: TestContext = {
    client: client as unknown as TestContext['client'],
    stationId: STATION_ID,
    tokens: {} as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl: SERVER_URL },
    callApi,
  };
  return { ctx, callApi };
}

describe('TC_B_100_CSMS', () => {
  it('requests the profile through the station security route and passes on identity and password', async () => {
    const { ctx, callApi } = makeContext((password) => ({
      identity: STATION_ID,
      basicAuthPassword: password,
    }));

    const result = await TC_B_100_CSMS.execute(ctx);

    expect(callApi).toHaveBeenCalledWith('PATCH', '/stations/sta_test', {
      securityProfile: 1,
      password: expect.any(String) as unknown,
    });
    expect(result.steps[0]?.status).toBe('passed');
    expect(result.status).toBe('passed');
  });

  it('fails when the profile carries no identity', async () => {
    const { ctx } = makeContext((password) => ({ basicAuthPassword: password }));

    const result = await TC_B_100_CSMS.execute(ctx);

    expect(result.steps[0]).toMatchObject({ status: 'failed', actual: 'Mismatched: identity' });
    expect(result.status).toBe('failed');
  });

  it('fails when the CSMS sends no SetNetworkProfileRequest', async () => {
    const { ctx, callApi } = makeContext(() => ({}));
    callApi.mockImplementation((method) =>
      Promise.resolve(
        method === 'GET'
          ? { status: 200, body: { isOnline: true } }
          : { status: 400, body: { code: 'VALIDATION_ERROR' } },
      ),
    );

    const result = await TC_B_100_CSMS.execute(ctx);

    expect(result.steps[0]?.status).toBe('failed');
    expect(result.steps[0]?.actual).toContain('No SetNetworkProfileRequest received');
  });
});
