// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, updates, state, configState } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  updates: [] as Record<string, unknown>[],
  state: {
    station: null as Record<string, unknown> | null,
    insertError: null as Error | null,
  },
  configState: { OCPP_STATION_TLS_URL: 'wss://ocpp.example.com/ocpp' },
}));

vi.mock('@evtivity/services/ocpp-command', () => ({ sendOcppCommandAndWait: sendMock }));
vi.mock('../lib/config.js', () => ({ config: configState }));
vi.mock('../lib/css-pairing.js', () => ({
  syncCssStationSecurity: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('argon2', () => ({ hash: vi.fn((pw: string) => Promise.resolve(`hash(${pw})`)) }));

vi.mock('@evtivity/database', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => Promise.resolve(state.station == null ? [] : [{ ...state.station }]),
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
      insert: () => ({
        values: () =>
          state.insertError != null ? Promise.reject(state.insertError) : Promise.resolve(),
      }),
    },
    chargingStations: {},
    connectionLogs: {},
    stationAuditLog: {},
    writeAudit: vi.fn(() => Promise.resolve(undefined)),
  };
});

import {
  changeSecurityProfile,
  changeStationPassword,
} from '../services/station-security.service.js';

const warn = vi.fn();
const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn },
};
const PW = 'abcdefghijKLMNOP1234';

function setStation(overrides: Record<string, unknown> = {}): void {
  state.station = {
    id: 'sta_1',
    stationId: 'CS-1',
    ocppProtocol: 'ocpp2.1',
    securityProfile: 1,
    pendingSecurityProfile: null,
    isOnline: true,
    basicAuthPasswordHash: 'old-hash',
    ...overrides,
  };
}

type Reply = { commandId: string; response?: Record<string, unknown>; error?: string };

/** Station replies for a 2.1 upgrade; `override` replaces the reply of one action. */
function stationReplies(priority: string, override: Record<string, Reply> = {}): void {
  sendMock.mockImplementation((_id: string, action: string, payload: Record<string, unknown>) => {
    const custom = override[action];
    if (custom != null) return Promise.resolve(custom);
    if (action === 'GetVariables') {
      const items = payload['getVariableData'] as {
        component: { name: string; instance?: string };
        variable: { name: string };
      }[];
      const values: Record<string, string> = {
        NetworkConfigurationPriority: priority,
        OcppCsmsUrl: 'ws://csms.example.com/ocpp',
        OcppInterface: 'Wired0',
        MessageTimeout: '30',
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
      response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
    });
  });
}

const pendingUpdates = (): unknown[] =>
  updates.filter((u) => 'pendingSecurityProfile' in u).map((u) => u['pendingSecurityProfile']);

beforeEach(() => {
  sendMock.mockReset();
  warn.mockReset();
  updates.length = 0;
  state.insertError = null;
  configState.OCPP_STATION_TLS_URL = 'wss://ocpp.example.com/ocpp';
  setStation();
});

describe('station lookup', () => {
  it('answers 404 STATION_NOT_FOUND for an unknown station', async () => {
    state.station = null;
    await expect(changeStationPassword('sta_x', PW, ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'STATION_NOT_FOUND',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('connection log failures', () => {
  it('still stores the password and warns when the connection log insert fails', async () => {
    state.insertError = new Error('insert failed');
    sendMock.mockResolvedValueOnce({
      commandId: 'c',
      response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
    });

    await expect(changeStationPassword('sta_1', PW, ctx)).resolves.toEqual({
      appliedTo: 'station',
    });
    expect(updates.some((u) => u['basicAuthPasswordHash'] === `hash(${PW})`)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      { err: state.insertError, stationId: 'sta_1' },
      'Failed to write connection_logs row',
    );
  });
});

describe('changeSecurityProfile on the same profile', () => {
  it('changes the password and reports unchanged when nothing is pending', async () => {
    sendMock.mockResolvedValueOnce({
      commandId: 'c',
      response: { setVariableResult: [{ attributeStatus: 'Accepted' }] },
    });

    await expect(changeSecurityProfile('sta_1', 1, PW, ctx)).resolves.toEqual({
      status: 'unchanged',
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
    expect(pendingUpdates()).toEqual([]);
  });
});

describe('OCPP 2.1 upgrade failures', () => {
  it('rejects when GetVariables fails and sends nothing else', async () => {
    stationReplies('1', { GetVariables: { commandId: 'c', error: 'timeout' } });
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
      code: 'OCPP_COMMAND_FAILED',
    });
    expect(sendMock.mock.calls.map((c) => c[1])).toEqual(['GetVariables']);
    expect(pendingUpdates()).toEqual([]);
  });

  it('rejects when the station reports no NetworkConfigurationPriority', async () => {
    stationReplies(' , ');
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STATION_SECURITY_CHANGE_REJECTED',
      message: 'The station did not report NetworkConfigurationPriority',
    });
    expect(pendingUpdates()).toEqual([]);
  });

  it('rejects when SetNetworkProfile gets no answer', async () => {
    stationReplies('1', { SetNetworkProfile: { commandId: 'c', error: 'timeout' } });
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
      code: 'OCPP_COMMAND_FAILED',
    });
    expect(sendMock.mock.calls.map((c) => c[1])).not.toContain('Reset');
    expect(pendingUpdates()).toEqual([]);
  });

  it('rejects when SetNetworkProfile is refused', async () => {
    stationReplies('1', {
      SetNetworkProfile: { commandId: 'c', response: { status: 'Rejected' } },
    });
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STATION_SECURITY_CHANGE_REJECTED',
      message: 'The station did not accept SetNetworkProfile (Rejected)',
    });
    expect(pendingUpdates()).toEqual([]);
  });

  it('rejects when Reset gets no answer', async () => {
    stationReplies('1', { Reset: { commandId: 'c', error: 'timeout' } });
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
      code: 'OCPP_COMMAND_FAILED',
    });
    expect(pendingUpdates()).toEqual([]);
  });

  it('accepts a Scheduled reset and rejects a refused one', async () => {
    stationReplies('1', { Reset: { commandId: 'c', response: { status: 'Scheduled' } } });
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).resolves.toEqual({
      status: 'pending',
    });
    expect(pendingUpdates()).toEqual([2]);

    updates.length = 0;
    stationReplies('1', { Reset: { commandId: 'c', response: { status: 'Rejected' } } });
    await expect(changeSecurityProfile('sta_1', 2, undefined, ctx)).rejects.toMatchObject({
      message: 'The station did not accept Reset (Rejected)',
    });
    expect(pendingUpdates()).toEqual([]);
  });
});
