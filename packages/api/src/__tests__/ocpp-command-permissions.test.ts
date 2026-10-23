// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Station commands need the write permission of the feature page on top of
// stations:write. Every
// generic command route checks `['stations:write', extra]`, and a certificate
// signing trigger needs certificates:write.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
vi.mock('../middleware/rbac.js', async () =>
  (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
);

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));
vi.mock('@evtivity/ocpp', () => ({ ActionRegistry: {}, ActionRegistry16: {} }));

// Past the permission check every handler reads the database: it fails here,
// so a route that lets the caller through answers 500, never 403.
const { dbCall } = vi.hoisted(() => ({
  dbCall: vi.fn(() => {
    throw new Error('database not available in this test');
  }),
}));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: dbCall,
    insert: dbCall,
    update: dbCall,
    delete: dbCall,
    execute: dbCall,
    transaction: dbCall,
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';
import {
  OCPP_COMMAND_EXTRA_PERMISSION,
  STATIONS_WRITE_ONLY_COMMANDS,
  ocppCommandExtraPermission,
  ocppCommandRoutePermissions,
} from '@evtivity/lib/ocpp-command-permissions';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

const EXPECTED: Record<string, string> = {
  UpdateFirmware: 'settings.firmware:write',
  PublishFirmware: 'settings.firmware:write',
  UnpublishFirmware: 'settings.firmware:write',
  SignedUpdateFirmware: 'settings.firmware:write',
  SetVariables: 'settings.stationConfig:write',
  ChangeConfiguration: 'settings.stationConfig:write',
  SetNetworkProfile: 'settings.stationConfig:write',
  SetVariableMonitoring: 'settings.stationConfig:write',
  ClearVariableMonitoring: 'settings.stationConfig:write',
  SetMonitoringBase: 'settings.stationConfig:write',
  SetMonitoringLevel: 'settings.stationConfig:write',
  InstallCertificate: 'certificates:write',
  DeleteCertificate: 'certificates:write',
  CertificateSigned: 'certificates:write',
  GetInstalledCertificateIds: 'certificates:write',
  SetChargingProfile: 'smartCharging:write',
  ClearChargingProfile: 'smartCharging:write',
  GetCompositeSchedule: 'smartCharging:write',
  GetChargingProfiles: 'smartCharging:write',
  ReserveNow: 'reservations:write',
  CancelReservation: 'reservations:write',
  RequestStartTransaction: 'sessions:write',
  RequestStopTransaction: 'sessions:write',
  RemoteStartTransaction: 'sessions:write',
  RemoteStopTransaction: 'sessions:write',
  // Grid signals need smartCharging, tariffs pricing.
  UpdateDynamicSchedule: 'smartCharging:write',
  SetDERControl: 'smartCharging:write',
  ClearDERControl: 'smartCharging:write',
  GetDERControl: 'smartCharging:write',
  AFRRSignal: 'smartCharging:write',
  UsePriorityCharging: 'smartCharging:write',
  SetDefaultTariff: 'pricing:write',
  ClearTariffs: 'pricing:write',
  ChangeTransactionTariff: 'pricing:write',
  // Vendor messages are station configuration.
  DataTransfer: 'settings.stationConfig:write',
  // Log uploads go to a URL the caller picks.
  GetLog: 'settings.stationConfig:write',
  GetDiagnostics: 'settings.stationConfig:write',
};

/** Actions that stay on stations:write alone (Reset among them). */
const STATIONS_WRITE_ONLY = ['Reset', 'TriggerMessage', 'UnlockConnector', 'ClearCache'];

describe('OCPP command permissions', () => {
  let app: FastifyInstance;
  let token: string;
  const commandUrls: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    app.addHook('onRoute', (route) => {
      if (route.url.startsWith('/ocpp/commands/')) commandUrls.push(route.url);
    });
    ocppCommandRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  function send(url: string, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'CS-1', ...payload },
    });
  }

  const action = (url: string): string => url.split('/').pop() ?? '';

  it('maps every action of the plan to its feature permission', () => {
    for (const [name, permission] of Object.entries(EXPECTED)) {
      expect(OCPP_COMMAND_EXTRA_PERMISSION[name], name).toBe(permission);
      expect(ocppCommandRoutePermissions(name)).toEqual(['stations:write', permission]);
    }
    for (const name of STATIONS_WRITE_ONLY) {
      expect(ocppCommandRoutePermissions(name), name).toEqual(['stations:write']);
    }
  });

  it('maps or allowlists every command route action, deny by default', () => {
    const unknown = commandUrls
      .map(action)
      .filter(
        (name) =>
          !STATIONS_WRITE_ONLY_COMMANDS.has(name) && OCPP_COMMAND_EXTRA_PERMISSION[name] == null,
      );
    expect(unknown).toEqual([]);
    // An action nobody listed needs settings.stationConfig:write.
    expect(ocppCommandRoutePermissions('SomeFutureCommand')).toEqual([
      'stations:write',
      'settings.stationConfig:write',
    ]);
  });

  it('registers the mapped actions as command routes', () => {
    const registered = new Set(commandUrls.map(action));
    for (const name of [
      'UpdateFirmware',
      'SetVariables',
      'ChangeConfiguration',
      'SetNetworkProfile',
      'InstallCertificate',
      'SetChargingProfile',
      'ReserveNow',
      'RequestStartTransaction',
      'RemoteStartTransaction',
      'SignedUpdateFirmware',
    ]) {
      expect(registered.has(name), name).toBe(true);
    }
  });

  it('refuses every mapped command with stations:write alone, and the client sends nothing', async () => {
    setMockPermissions(['stations:read', 'stations:write']);
    for (const url of commandUrls) {
      const name = action(url);
      const res = await send(url);
      if (ocppCommandExtraPermission(name) != null) {
        expect(res.statusCode, url).toBe(403);
        expect(res.json(), url).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
      } else {
        expect(res.statusCode, url).not.toBe(403);
      }
    }
  });

  it('lets every command through with stations:write and its feature permission', async () => {
    for (const url of commandUrls) {
      setMockPermissions(ocppCommandRoutePermissions(action(url)));
      const res = await send(url);
      expect(res.statusCode, url).not.toBe(403);
    }
  });

  it('refuses a Plug and Charge DataTransfer without certificates:write', async () => {
    const pnc = {
      vendorId: 'org.openchargealliance.iso15118pnc',
      messageId: 'InstallCertificate',
      data: JSON.stringify({ certificateType: 'V2GRootCertificate', certificate: 'PEM' }),
    };
    setMockPermissions(['stations:write']);
    const plain = await send('/ocpp/commands/v16/DataTransfer', { vendorId: 'acme' });
    expect(plain.statusCode).toBe(403);

    setMockPermissions(['stations:write', 'settings.stationConfig:write']);
    const vendor = await send('/ocpp/commands/v16/DataTransfer', { vendorId: 'acme' });
    expect(vendor.statusCode).not.toBe(403);
    const refused = await send('/ocpp/commands/v16/DataTransfer', pnc);
    expect(refused.statusCode).toBe(403);
    const upperCase = await send('/ocpp/commands/v16/DataTransfer', {
      ...pnc,
      vendorId: 'ORG.OPENCHARGEALLIANCE.ISO15118PNC',
    });
    expect(upperCase.statusCode).toBe(403);

    setMockPermissions(['stations:write', 'settings.stationConfig:write', 'certificates:write']);
    const allowed = await send('/ocpp/commands/v16/DataTransfer', pnc);
    expect(allowed.statusCode).not.toBe(403);
  });

  it('refuses a certificate signing trigger without certificates:write', async () => {
    setMockPermissions(['stations:write']);
    const v16 = await send('/ocpp/commands/v16/ExtendedTriggerMessage', {
      requestedMessage: 'SignChargePointCertificate',
    });
    expect(v16.statusCode).toBe(403);
    const v21 = await send('/ocpp/commands/v21/TriggerMessage', {
      requestedMessage: 'SignChargingStationCertificate',
    });
    expect(v21.statusCode).toBe(403);
    const heartbeat = await send('/ocpp/commands/v21/TriggerMessage', {
      requestedMessage: 'Heartbeat',
    });
    expect(heartbeat.statusCode).not.toBe(403);

    setMockPermissions(['stations:write', 'certificates:write']);
    const allowed = await send('/ocpp/commands/v16/ExtendedTriggerMessage', {
      requestedMessage: 'SignChargePointCertificate',
    });
    expect(allowed.statusCode).not.toBe(403);
  });
});
