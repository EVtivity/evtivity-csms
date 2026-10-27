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
  DataPlanSettingInTemplateError,
  assertMaskableUrlPasswords,
  assertNoBootOwnedVariables,
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

  it('refuses the boot-owned template variables of each version and names them', () => {
    const refused = (version: string, vars: { component: string; variable: string }[]) => {
      try {
        assertNoBootOwnedVariables(version, vars);
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(DataPlanSettingInTemplateError);
        const e = err as DataPlanSettingInTemplateError;
        expect(e.statusCode).toBe(400);
        expect(e.code).toBe('DATA_PLAN_SETTING_IN_TEMPLATE');
        return e.variables;
      }
    };
    expect(
      refused('1.6', [
        { component: '', variable: ' HeartbeatInterval ' },
        { component: '', variable: 'StopTxnSampledData' },
        { component: '', variable: 'LocalPreAuthorize' },
      ]),
    ).toEqual(['HeartbeatInterval', 'StopTxnSampledData']);
    expect(
      refused('2.1', [
        { component: 'AlignedDataCtrlr', variable: 'Interval' },
        { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands' },
        { component: 'SampledDataCtrlr', variable: 'TxStartedMeasurands' },
      ]),
    ).toEqual(['AlignedDataCtrlr.Interval', 'SampledDataCtrlr.TxUpdatedMeasurands']);
    // The component compares as stored (case kept); the instance does not matter.
    expect(refused('2.1', [{ component: 'alignedDataCtrlr', variable: 'Interval' }])).toBeNull();
    expect(
      refused('2.1', [
        { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', variableInstance: 'X' } as {
          component: string;
          variable: string;
        },
      ]),
    ).toEqual(['OCPPCommCtrlr.HeartbeatInterval']);
    // A 1.6 key in a 2.1 template is not the 2.1 variable.
    expect(refused('2.1', [{ component: '', variable: 'HeartbeatInterval' }])).toBeNull();
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

  // A space or control inside a URL userinfo: the station reads the whole
  // password, the stored copies could not mask it.
  it.each([
    [
      '/ocpp/commands/v21/GetLog',
      {
        stationId: 'CS-21',
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: 'ftp://logs:pa ss@files.example.com/up' },
      },
    ],
    [
      '/ocpp/commands/v16/GetDiagnostics',
      { stationId: 'CS-16', location: 'ftp://logs:pa\tss@files.example.com/up' },
    ],
    [
      '/ocpp/commands/v21/UpdateFirmware',
      {
        stationId: 'CS-21',
        requestId: 1,
        firmware: {
          location: 'ftp://fw:pa/ss@files.example.com/fw.bin',
          retrieveDateTime: '2026-10-27T00:00:00Z',
        },
      },
    ],
  ])('%s refuses a URL password the stored copies cannot mask', async (url, payload) => {
    pubsub.publish.mockClear();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    // The reply never echoes the refused value.
    expect(res.body).not.toContain('files.example.com');
    expect(pubsub.publish).not.toHaveBeenCalled();
  });
});

describe('file transfer URL length on the generic OCPP command routes', () => {
  let app: FastifyInstance;
  let token: string;
  const long = `ftp://u:p@files.example.com/${'x'.repeat(2000)}`;

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
    ['/ocpp/commands/v16/GetDiagnostics', { stationId: 'CS-16', location: long }],
    [
      '/ocpp/commands/v16/UpdateFirmware',
      { stationId: 'CS-16', location: long, retrieveDate: '2026-10-27T00:00:00Z' },
    ],
    [
      '/ocpp/commands/v21/PublishFirmware',
      { stationId: 'CS-21', location: long, checksum: 'abc', requestId: 1 },
    ],
    [
      '/ocpp/commands/v21/UpdateFirmware',
      {
        stationId: 'CS-21',
        requestId: 1,
        firmware: { location: long, retrieveDateTime: '2026-10-27T00:00:00Z' },
      },
    ],
    [
      '/ocpp/commands/v21/GetLog',
      {
        stationId: 'CS-21',
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: { remoteLocation: long },
      },
    ],
  ])('%s refuses a URL longer than 2000 characters', async (url, payload) => {
    pubsub.publish.mockClear();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('files.example.com');
    expect(pubsub.publish).not.toHaveBeenCalled();
  });
});

describe('assertMaskableUrlPasswords', () => {
  it('refuses a userinfo with a space or control, accepts any other URL password', () => {
    expect(refusal(() => assertMaskableUrlPasswords({ location: 'ftp://u:a b@h/x' }))).toBe(
      '400 VALIDATION_ERROR',
    );
    expect(refusal(() => assertMaskableUrlPasswords('ftp://u:a\nb@h/x'))).toBe(
      '400 VALIDATION_ERROR',
    );
    expect(refusal(() => assertMaskableUrlPasswords({ location: 'ftp://u:a"b\\c@h/x' }))).toBe(
      null,
    );
    expect(refusal(() => assertMaskableUrlPasswords('https://h/fw 1.bin'))).toBe(null);
  });
});
