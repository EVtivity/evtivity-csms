// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, syncCssMock, updates, station, configState } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  syncCssMock: vi.fn(() => Promise.resolve(undefined)),
  updates: [] as Record<string, unknown>[],
  station: {},
  configState: { OCPP_STATION_TLS_URL: undefined as string | undefined },
}));

vi.mock('@evtivity/services/ocpp-command', () => ({ sendOcppCommandAndWait: sendMock }));
vi.mock('../lib/config.js', () => ({ config: configState }));
vi.mock('../lib/css-pairing.js', () => ({ syncCssStationSecurity: syncCssMock }));
vi.mock('argon2', () => ({ hash: vi.fn((pw: string) => Promise.resolve(`hash(${pw})`)) }));

vi.mock('@evtivity/database', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => Promise.resolve([{ ...station }]),
  };
  const updateChain = {
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return updateChain;
    },
    where: () => Promise.resolve(undefined),
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => ({ values: () => Promise.resolve(undefined) }),
    },
    chargingStations: {},
    connectionLogs: {},
    stationAuditLog: {},
    writeAudit: vi.fn(() => Promise.resolve(undefined)),
  };
});

import {
  changeStationPassword,
  rotateStationPassword,
  changeSecurityProfile,
} from '../services/station-security.service.js';

const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn: vi.fn() },
};
const PW = 'abcdefghijKLMNOP1234';

function setStation(overrides: Record<string, unknown>): void {
  for (const k of Object.keys(station)) Reflect.deleteProperty(station, k);
  Object.assign(station, {
    id: 'sta_1',
    stationId: 'CS-1',
    ocppProtocol: 'ocpp2.1',
    securityProfile: 1,
    pendingSecurityProfile: null,
    isOnline: true,
    basicAuthPasswordHash: 'old-hash',
    ...overrides,
  });
}

const accepted = {
  commandId: 'c',
  response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
};
const actions = (): string[] => sendMock.mock.calls.map((c) => c[1] as string);
const hashUpdates = (): unknown[] =>
  updates.filter((u) => 'basicAuthPasswordHash' in u).map((u) => u['basicAuthPasswordHash']);

beforeEach(() => {
  sendMock.mockReset();
  updates.length = 0;
  configState.OCPP_STATION_TLS_URL = undefined;
  setStation({});
});

describe('changeStationPassword', () => {
  it('sends SetVariables(BasicAuthPassword) without a version and stores the hash on Accepted', async () => {
    sendMock.mockResolvedValueOnce(accepted);

    await expect(changeStationPassword('sta_1', PW, ctx)).resolves.toEqual({
      appliedTo: 'station',
    });

    expect(sendMock).toHaveBeenCalledWith('CS-1', 'SetVariables', {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: PW,
        },
      ],
    });
    expect(sendMock.mock.calls[0]).toHaveLength(3);
    expect(hashUpdates()).toEqual([`hash(${PW})`]);
  });

  it('accepts a 1.6 ChangeConfiguration status reply', async () => {
    setStation({ ocppProtocol: 'ocpp1.6' });
    sendMock.mockResolvedValueOnce({ commandId: 'c', response: { status: 'Accepted' } });

    await changeStationPassword('sta_1', PW, ctx);

    expect(hashUpdates()).toEqual([`hash(${PW})`]);
  });

  it('keeps the old password when the station rejects (no lockout, A01.FR.03)', async () => {
    sendMock.mockResolvedValueOnce({ commandId: 'c', response: { status: 'NotSupported' } });

    await expect(changeStationPassword('sta_1', PW, ctx)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STATION_SECURITY_CHANGE_REJECTED',
    });
    expect(hashUpdates()).toEqual([]);
  });

  it('keeps the old password when the station does not answer', async () => {
    sendMock.mockResolvedValueOnce({ commandId: 'c', error: 'No response within 35s' });

    await expect(changeStationPassword('sta_1', PW, ctx)).rejects.toMatchObject({
      code: 'OCPP_COMMAND_FAILED',
    });
    expect(hashUpdates()).toEqual([]);
  });

  it('rejects a 1.6 password longer than 20 characters before sending anything', async () => {
    setStation({ ocppProtocol: 'ocpp1.6' });

    await expect(changeStationPassword('sta_1', 'a'.repeat(21), ctx)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('stores the password without sending when the station is offline', async () => {
    setStation({ isOnline: false });

    await expect(changeStationPassword('sta_1', PW, ctx)).resolves.toEqual({ appliedTo: 'stored' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(hashUpdates()).toEqual([`hash(${PW})`]);
  });
});

describe('rotateStationPassword', () => {
  it('requires an online station', async () => {
    setStation({ isOnline: false });
    await expect(rotateStationPassword('sta_1', ctx)).rejects.toMatchObject({
      code: 'STATION_OFFLINE',
    });
  });

  it('only applies to security profiles 1 and 2', async () => {
    setStation({ securityProfile: 3 });
    await expect(rotateStationPassword('sta_1', ctx)).rejects.toMatchObject({
      code: 'ROTATION_NOT_APPLICABLE',
    });
  });

  it('sends a generated 20-character password and stores it on Accepted', async () => {
    sendMock.mockResolvedValueOnce(accepted);

    await rotateStationPassword('sta_1', ctx);

    const payload = sendMock.mock.calls[0]?.[2] as {
      setVariableData: { attributeValue: string }[];
    };
    const sent = payload.setVariableData[0]?.attributeValue ?? '';
    expect(sent).toMatch(/^[a-zA-Z0-9]{20}$/);
    expect(hashUpdates()).toEqual([`hash(${sent})`]);
  });
});

describe('changeSecurityProfile', () => {
  it('refuses to lower a connected station profile', async () => {
    setStation({ securityProfile: 2 });
    await expect(changeSecurityProfile('sta_1', 1, undefined, ctx)).rejects.toMatchObject({
      code: 'SECURITY_PROFILE_DOWNGRADE',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('saves the profile directly for an offline station', async () => {
    setStation({ isOnline: false, securityProfile: 2 });

    await expect(changeSecurityProfile('sta_1', 1, undefined, ctx)).resolves.toEqual({
      status: 'updated',
    });
    expect(updates[0]).toMatchObject({ securityProfile: 1, pendingSecurityProfile: null });
    expect(sendMock).not.toHaveBeenCalled();
    expect(syncCssMock).toHaveBeenCalledWith('CS-1', { securityProfile: 1, password: undefined });
  });

  it('cancels a pending upgrade when the current profile is saved', async () => {
    setStation({ pendingSecurityProfile: 2 });

    await expect(changeSecurityProfile('sta_1', 1, undefined, ctx)).resolves.toEqual({
      status: 'updated',
    });
    expect(updates[0]).toMatchObject({ pendingSecurityProfile: null });
  });

  it('requires a password when a station without one moves to profile 1', async () => {
    setStation({ securityProfile: 0, basicAuthPasswordHash: null });
    await expect(changeSecurityProfile('sta_1', 1, undefined, ctx)).rejects.toMatchObject({
      code: 'PASSWORD_REQUIRED',
    });
  });

  describe('OCPP 2.1 (A05)', () => {
    function stationReplies(priority: string): void {
      sendMock.mockImplementation(
        (_id: string, action: string, payload: Record<string, unknown>) => {
          if (action === 'GetVariables') {
            const items = payload['getVariableData'] as {
              component: { name: string; instance?: string };
              variable: { name: string };
            }[];
            const values: Record<string, string> = {
              NetworkConfigurationPriority: priority,
              OcppCsmsUrl: 'ws://csms.example.com/ocpp',
              OcppInterface: 'Wireless0',
              MessageTimeout: '45',
            };
            return Promise.resolve({
              commandId: 'c',
              response: {
                getVariableResult: items.map((i) => ({
                  attributeStatus: 'Accepted',
                  attributeValue: values[i.variable.name],
                  component: i.component,
                  variable: i.variable,
                })),
              },
            });
          }
          if (action === 'SetNetworkProfile' || action === 'Reset') {
            return Promise.resolve({ commandId: 'c', response: { status: 'Accepted' } });
          }
          return Promise.resolve({
            commandId: 'c',
            response: { setVariableResult: [{ attributeStatus: 'RebootRequired' }] },
          });
        },
      );
    }

    it('moves a station from profile 1 to 2 over the public TLS address', async () => {
      configState.OCPP_STATION_TLS_URL = 'wss://ocpp.example.com/ocpp';
      stationReplies('1');

      await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).resolves.toEqual({
        status: 'pending',
      });

      expect(actions()).toEqual([
        'GetVariables',
        'GetVariables',
        'SetNetworkProfile',
        'SetVariables',
        'Reset',
      ]);
      expect(sendMock.mock.calls[2]?.[2]).toEqual({
        configurationSlot: 2,
        connectionData: {
          ocppVersion: 'OCPP20',
          ocppInterface: 'Wireless0',
          ocppTransport: 'JSON',
          messageTimeout: 45,
          ocppCsmsUrl: 'wss://ocpp.example.com/ocpp',
          securityProfile: 2,
        },
      });
      expect(sendMock.mock.calls[3]?.[2]).toEqual({
        setVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'NetworkConfigurationPriority' },
            attributeValue: '2,1',
          },
        ],
      });
      expect(sendMock.mock.calls[4]?.[2]).toEqual({ type: 'OnIdle' });
      expect(updates.at(-1)).toMatchObject({ pendingSecurityProfile: 2 });
    });

    it('refuses the TLS move when the public TLS address is not configured', async () => {
      stationReplies('1');

      await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
        code: 'STATION_TLS_URL_NOT_CONFIGURED',
      });
      expect(actions()).not.toContain('SetNetworkProfile');
    });

    it('moves 0 to 1 on the current address and carries the new password in the profile', async () => {
      setStation({ securityProfile: 0, basicAuthPasswordHash: null });
      stationReplies('1,3');

      await changeSecurityProfile('sta_1', 1, PW, ctx);

      expect(sendMock.mock.calls[2]?.[2]).toMatchObject({
        configurationSlot: 2,
        connectionData: {
          ocppCsmsUrl: 'ws://csms.example.com/ocpp',
          securityProfile: 1,
          basicAuthPassword: PW,
        },
      });
      expect(hashUpdates()).toEqual([`hash(${PW})`]);
      expect(updates.at(-1)).toMatchObject({ pendingSecurityProfile: 1 });
    });

    it('does not mark the upgrade pending when the station rejects the priority (no root certificate)', async () => {
      configState.OCPP_STATION_TLS_URL = 'wss://ocpp.example.com/ocpp';
      stationReplies('1');
      const base = sendMock.getMockImplementation() as (
        id: string,
        action: string,
        payload: Record<string, unknown>,
      ) => Promise<unknown>;
      sendMock.mockImplementation((id: string, action: string, payload: Record<string, unknown>) =>
        action === 'SetVariables'
          ? Promise.resolve({
              commandId: 'c',
              response: { setVariableResult: [{ attributeStatus: 'Rejected' }] },
            })
          : base(id, action, payload),
      );

      await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
        code: 'STATION_SECURITY_CHANGE_REJECTED',
      });
      expect(updates.some((u) => u['pendingSecurityProfile'] === 2)).toBe(false);
      expect(actions()).not.toContain('Reset');
    });

    it('applies a new password first when the station already uses one, then upgrades without it', async () => {
      configState.OCPP_STATION_TLS_URL = 'wss://ocpp.example.com/ocpp';
      stationReplies('1');
      const base = sendMock.getMockImplementation() as (
        id: string,
        action: string,
        payload: Record<string, unknown>,
      ) => Promise<unknown>;
      sendMock.mockImplementation((id: string, action: string, payload: Record<string, unknown>) =>
        action === 'SetVariables' && JSON.stringify(payload).includes('BasicAuthPassword')
          ? Promise.resolve(accepted)
          : base(id, action, payload),
      );

      await changeSecurityProfile('sta_1', 2, PW, ctx);

      expect(actions()[0]).toBe('SetVariables');
      const profile = sendMock.mock.calls.find((c) => c[1] === 'SetNetworkProfile')?.[2] as {
        connectionData: Record<string, unknown>;
      };
      expect(profile.connectionData).not.toHaveProperty('basicAuthPassword');
    });
  });

  describe('OCPP 1.6 (Security Whitepaper)', () => {
    it('sends AuthorizationKey, SecurityProfile, then a Hard reset', async () => {
      setStation({ ocppProtocol: 'ocpp1.6', securityProfile: 0, basicAuthPasswordHash: null });
      sendMock.mockResolvedValue({ commandId: 'c', response: { status: 'Accepted' } });

      await expect(changeSecurityProfile('sta_1', 1, PW, ctx)).resolves.toEqual({
        status: 'pending',
      });

      expect(actions()).toEqual(['SetVariables', 'SetVariables', 'Reset']);
      expect(JSON.stringify(sendMock.mock.calls[0]?.[2])).toContain('BasicAuthPassword');
      expect(sendMock.mock.calls[1]?.[2]).toEqual({
        setVariableData: [
          {
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'SecurityProfile' },
            attributeValue: '1',
          },
        ],
      });
      // 2.1 Immediate is translated to the 1.6 Hard reset.
      expect(sendMock.mock.calls[2]?.[2]).toEqual({ type: 'Immediate' });
      expect(updates.at(-1)).toMatchObject({ pendingSecurityProfile: 1 });
    });
  });
});
