// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Station credentials change only through POST /v1/stations/:id/credentials:
// the generic OCPP command routes, configuration templates, the assistant and
// MCP refuse them (rule features/station-security.md).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const pubsub = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
  invalidatePermissionCache: vi.fn(),
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: pubsub.publish,
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn(),
  })),
  setPubSub: vi.fn(),
}));
// The refusal comes before any payload validation or dispatch.
vi.mock('@evtivity/ocpp', () => ({ ActionRegistry: {}, ActionRegistry16: {} }));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { AppError } from '@evtivity/lib';
import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';
import {
  assertNoCredentialVariables,
  assertNoStationCredentialWrite,
} from '../lib/station-credential-guard.js';
import { mcpOffers, surfaceOffers, toolPolicy } from '../services/ai/tools/policy.js';

const CODE = 'STATION_CREDENTIALS_ROUTE_REQUIRED';
const PASSWORD = 'SeedStationPass1234';

const SET_PASSWORD_21 = {
  setVariableData: [
    {
      component: { name: 'SecurityCtrlr' },
      variable: { name: 'BasicAuthPassword' },
      attributeValue: PASSWORD,
    },
  ],
};
const CONNECTION_DATA = {
  ocppVersion: 'OCPP20',
  ocppTransport: 'JSON',
  ocppCsmsUrl: 'wss://csms.example.com/ocpp',
  messageTimeout: 30,
  securityProfile: 2,
  ocppInterface: 'Wired0',
};

function refusal(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? `${String(err.statusCode)} ${err.code}` : 'other';
  }
}

describe('station credential guard', () => {
  it('refuses a 2.1 SetVariables BasicAuthPassword write, not other variables', () => {
    expect(refusal(() => assertNoStationCredentialWrite('SetVariables', SET_PASSWORD_21))).toBe(
      `400 ${CODE}`,
    );
    expect(
      refusal(() =>
        assertNoStationCredentialWrite('SetVariables', {
          setVariableData: [
            {
              component: { name: 'AuthCtrlr' },
              variable: { name: 'LocalPreAuthorization' },
              attributeValue: 'true',
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('refuses a 1.6 ChangeConfiguration AuthorizationKey write, not other keys or reads', () => {
    expect(
      refusal(() =>
        assertNoStationCredentialWrite('ChangeConfiguration', {
          key: 'AuthorizationKey',
          value: '5365656453746174',
        }),
      ),
    ).toBe(`400 ${CODE}`);
    expect(
      refusal(() =>
        assertNoStationCredentialWrite('ChangeConfiguration', {
          key: 'HeartbeatInterval',
          value: '300',
        }),
      ),
    ).toBeNull();
    expect(
      refusal(() =>
        assertNoStationCredentialWrite('GetConfiguration', { key: ['AuthorizationKey'] }),
      ),
    ).toBeNull();
  });

  it('refuses SetNetworkProfile with basicAuthPassword, allows it without', () => {
    expect(
      refusal(() =>
        assertNoStationCredentialWrite('SetNetworkProfile', {
          configurationSlot: 2,
          connectionData: { ...CONNECTION_DATA, basicAuthPassword: PASSWORD },
        }),
      ),
    ).toBe(`400 ${CODE}`);
    expect(
      refusal(() =>
        assertNoStationCredentialWrite('SetNetworkProfile', {
          configurationSlot: 2,
          connectionData: CONNECTION_DATA,
        }),
      ),
    ).toBeNull();
  });

  it('refuses configuration template variables that name a credential (both versions)', () => {
    expect(
      refusal(() =>
        assertNoCredentialVariables([
          { component: 'SecurityCtrlr', variable: 'BasicAuthPassword' },
        ]),
      ),
    ).toBe(`400 ${CODE}`);
    expect(
      refusal(() => assertNoCredentialVariables([{ component: '', variable: 'AuthorizationKey' }])),
    ).toBe(`400 ${CODE}`);
    expect(
      refusal(() =>
        assertNoCredentialVariables([{ component: '', variable: 'HeartbeatInterval' }]),
      ),
    ).toBeNull();
  });

  it('refuses a credential variable name with surrounding spaces', () => {
    expect(
      refusal(() =>
        assertNoCredentialVariables([
          { component: 'SecurityCtrlr', variable: 'BasicAuthPassword ' },
        ]),
      ),
    ).toBe(`400 ${CODE}`);
  });

  it('refuses template variables that set the security or network profile (both versions)', () => {
    const SECURITY_CODE = 'STATION_SECURITY_ROUTE_REQUIRED';
    for (const v of [
      { component: '', variable: 'SecurityProfile' },
      { component: 'SecurityCtrlr', variable: 'SecurityProfile' },
      { component: 'OCPPCommCtrlr', variable: 'NetworkConfigurationPriority' },
      { component: 'NetworkConfiguration', variable: 'OcppCsmsUrl' },
      { component: 'ocppcommctrlr', variable: ' NetworkConfigurationPriority' },
    ]) {
      expect(refusal(() => assertNoCredentialVariables([v]))).toBe(`400 ${SECURITY_CODE}`);
    }
    for (const v of [
      { component: 'SecurityCtrlr', variable: 'AllowSecurityProfileDowngrade' },
      { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' },
      { component: 'TxCtrlr', variable: 'SecurityProfile' },
    ]) {
      expect(refusal(() => assertNoCredentialVariables([v]))).toBeNull();
    }
  });

  it('the assistant and MCP never offer the generic configuration write commands', () => {
    for (const op of [
      'ocppv21_SetVariables',
      'ocppv16_ChangeConfiguration',
      'ocppv21_SetNetworkProfile',
    ]) {
      expect(toolPolicy(op).exposure, op).toBe('never');
      expect(surfaceOffers(toolPolicy(op), 'chatbot'), op).toBe(false);
      expect(mcpOffers(op), op).toBe(false);
    }
    // Template writes the assistant may propose run through the guarded routes.
    for (const op of ['createConfigTemplate', 'updateConfigTemplate', 'pushConfigTemplate']) {
      expect(mcpOffers(op), op).toBe(false);
    }
  });
});

describe('generic OCPP command routes refuse station credential writes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    ocppCommandRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['/ocpp/commands/v21/SetVariables', { stationId: 'CS-21', ...SET_PASSWORD_21 }],
    [
      '/ocpp/commands/v16/ChangeConfiguration',
      { stationId: 'CS-16', key: 'AuthorizationKey', value: '5365656453746174' },
    ],
    [
      '/ocpp/commands/v21/SetNetworkProfile',
      {
        stationId: 'CS-21',
        configurationSlot: 2,
        connectionData: { ...CONNECTION_DATA, basicAuthPassword: PASSWORD },
      },
    ],
  ])('%s answers 400 and sends nothing', async (url, payload) => {
    pubsub.publish.mockClear();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: CODE });
    expect(pubsub.publish).not.toHaveBeenCalled();
  });
});
