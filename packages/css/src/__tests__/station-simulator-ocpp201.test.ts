// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chaosActionsFor } from '../chaos-orchestrator.js';
import { SimulatorManager } from '../simulator-manager.js';
import { liveHarness, makeHarness, silenceConsole, stubSql, type Harness } from './sim-harness.js';
import { isOcpp201Message } from './ocpp201-schema.js';

// Every message these stations send passes through the harness's strict 2.0.1
// check (the client's own 2.0.1 edge first), and every CSMS call handed to
// `invoke` is checked as a 2.0.1 request, so a 2.1-only field fails the test.

function txEvents(h: Harness, type?: string): Array<Record<string, unknown>> {
  return h.sent('TransactionEvent').filter((e) => type == null || e['eventType'] === type);
}

function infoOf(e: Record<string, unknown> | undefined): Record<string, unknown> {
  return (e?.['transactionInfo'] as Record<string, unknown> | undefined) ?? {};
}

async function settle(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('OCPP 2.0.1 simulator station', () => {
  it('boots, charges and stops with 2.0.1 messages only', async () => {
    const h = await liveHarness('ocpp2.0.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-201');
    await settle(25_000);
    await h.sim.suspendCharging(1, 'EVSE');
    await h.sim.resumeCharging(1);
    await h.sim.stopCharging(1, 'Remote');
    await h.sim.unplug(1);
    await settle();

    expect(h.violations).toEqual([]);
    expect(txEvents(h, 'Started')).toHaveLength(1);
    expect(txEvents(h, 'Updated').length).toBeGreaterThan(0);
    expect(txEvents(h, 'Ended')[0]?.['triggerReason']).toBe('RemoteStop');
    expect(h.actions()).toContain('StatusNotification');
  });

  it('ends an EV-full session with the 2.0.1 trigger reason', async () => {
    const h = await liveHarness('ocpp2.0.1');
    await h.sim.plugIn(1);
    await h.sim.startCharging(1, 'TAG-201');
    await h.sim.evFull(1);
    await settle();

    expect(h.violations).toEqual([]);
    const ended = txEvents(h, 'Ended')[0];
    expect(ended?.['triggerReason']).toBe('EnergyLimitReached');
    expect(infoOf(ended)['stoppedReason']).toBe('SOCLimitReached');
  });

  it('refuses a stop reason 2.0.1 does not define', async () => {
    const h = await liveHarness('ocpp2.0.1');
    await expect(h.sim.stopCharging(1, 'ReqEnergyTransferRejected')).rejects.toThrow(
      'Stop reason ReqEnergyTransferRejected is not an OCPP 2.0.1 stop reason',
    );
  });

  it('answers 2.0.1 CSMS calls with 2.0.1 replies', async () => {
    const h = await liveHarness('ocpp2.0.1');
    const calls: Array<[string, Record<string, unknown>]> = [
      [
        'GetVariables',
        {
          getVariableData: [
            { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
          ],
        },
      ],
      [
        'SetVariables',
        {
          setVariableData: [
            {
              attributeValue: '120',
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: 'HeartbeatInterval' },
            },
          ],
        },
      ],
      ['GetBaseReport', { requestId: 1, reportBase: 'FullInventory' }],
      ['GetReport', { requestId: 2, componentVariable: [{ component: { name: 'TxCtrlr' } }] }],
      [
        'SetVariableMonitoring',
        {
          setMonitoringData: [
            {
              value: 1,
              type: 'Delta',
              severity: 5,
              component: { name: 'EVSE', evse: { id: 1 } },
              variable: { name: 'Power' },
            },
          ],
        },
      ],
      ['GetMonitoringReport', { requestId: 3 }],
      ['SetMonitoringBase', { monitoringBase: 'All' }],
      ['SetMonitoringLevel', { severity: 5 }],
      [
        'SetChargingProfile',
        {
          evseId: 1,
          chargingProfile: {
            id: 10,
            stackLevel: 0,
            chargingProfilePurpose: 'TxDefaultProfile',
            chargingProfileKind: 'Absolute',
            chargingSchedule: [
              {
                id: 10,
                startSchedule: new Date().toISOString(),
                chargingRateUnit: 'W',
                chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
              },
            ],
          },
        },
      ],
      [
        'GetChargingProfiles',
        { requestId: 4, chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' } },
      ],
      ['GetCompositeSchedule', { duration: 3600, evseId: 1, chargingRateUnit: 'W' }],
      ['ClearChargingProfile', { chargingProfileId: 10 }],
      [
        'SetDisplayMessage',
        {
          message: {
            id: 1,
            priority: 'NormalCycle',
            message: { format: 'UTF8', content: 'Welcome' },
          },
        },
      ],
      ['GetDisplayMessages', { requestId: 5 }],
      ['ClearDisplayMessage', { id: 1 }],
      ['GetInstalledCertificateIds', {}],
      ['GetLocalListVersion', {}],
      [
        'SendLocalList',
        {
          versionNumber: 2,
          updateType: 'Full',
          localAuthorizationList: [
            {
              idToken: { idToken: 'LOCAL-1', type: 'ISO14443' },
              idTokenInfo: { status: 'Accepted' },
            },
          ],
        },
      ],
      ['ClearCache', {}],
      ['TriggerMessage', { requestedMessage: 'Heartbeat' }],
      [
        'TriggerMessage',
        { requestedMessage: 'StatusNotification', evse: { id: 1, connectorId: 1 } },
      ],
      ['TriggerMessage', { requestedMessage: 'MeterValues', evse: { id: 1 } }],
      ['ChangeAvailability', { operationalStatus: 'Inoperative', evse: { id: 1 } }],
      ['ChangeAvailability', { operationalStatus: 'Operative', evse: { id: 1 } }],
      ['UnlockConnector', { evseId: 1, connectorId: 1 }],
      [
        'ReserveNow',
        {
          id: 7,
          expiryDateTime: new Date(Date.now() + 600_000).toISOString(),
          idToken: { idToken: 'RES-1', type: 'ISO14443' },
          evseId: 1,
        },
      ],
      ['CancelReservation', { reservationId: 7 }],
      [
        'CustomerInformation',
        {
          requestId: 6,
          report: true,
          clear: false,
          idToken: { idToken: 'TAG-201', type: 'ISO14443' },
        },
      ],
      ['GetTransactionStatus', {}],
      ['DataTransfer', { vendorId: 'com.example' }],
      [
        'SetNetworkProfile',
        {
          configurationSlot: 2,
          connectionData: {
            ocppVersion: 'OCPP20',
            ocppTransport: 'JSON',
            ocppCsmsUrl: 'ws://localhost:7103',
            messageTimeout: 30,
            securityProfile: 0,
            ocppInterface: 'Wired0',
          },
        },
      ],
      [
        'GetLog',
        {
          logType: 'DiagnosticsLog',
          requestId: 8,
          log: { remoteLocation: 'https://logs.example.com/upload' },
        },
      ],
      ['Reset', { type: 'OnIdle' }],
    ];
    for (const [action, payload] of calls) {
      await h.invoke(action, payload);
      await settle(200);
    }
    await settle(5000);
    expect(h.violations).toEqual([]);
    expect(h.actions()).toEqual(expect.arrayContaining(['NotifyReport', 'NotifyMonitoringReport']));
  });

  it('starts and stops a remote transaction', async () => {
    const h = await liveHarness('ocpp2.0.1');
    await h.sim.plugIn(1);
    const started = await h.invoke('RequestStartTransaction', {
      evseId: 1,
      remoteStartId: 42,
      idToken: { idToken: 'REMOTE-1', type: 'Central' },
    });
    expect(started['status']).toBe('Accepted');
    await settle(3000);
    const txId = infoOf(txEvents(h, 'Started')[0])['transactionId'] as string;
    await h.invoke('RequestStopTransaction', { transactionId: txId });
    await settle(3000);
    expect(h.violations).toEqual([]);
    expect(txEvents(h, 'Ended')).toHaveLength(1);
  });

  it('fails the check for a CSMS call with a 2.1-only value', async () => {
    const h = await makeHarness({ protocol: 'ocpp2.0.1' });
    await expect(h.invoke('Reset', { type: 'ImmediateAndResume' })).rejects.toThrow(
      /Reset request fails the OCPP 2.0.1 schema/,
    );
  });

  it('sends Autocharge with the EVCCID as a MacAddress token and refuses VIN', async () => {
    const h = await liveHarness('ocpp2.0.1');
    await h.sim.plugInEv(1, { autocharge: 'EVCCID', evccid: '0A1B2C3D4E5F' });
    await settle(1000);
    expect(h.violations).toEqual([]);
    const authorize = h.sent('Authorize')[0];
    expect(authorize?.['idToken']).toMatchObject({ idToken: '0A1B2C3D4E5F', type: 'MacAddress' });

    const v = await liveHarness('ocpp2.0.1');
    await expect(
      v.sim.plugInEv(1, { autocharge: 'VIN', vin: 'WVW00000000000001' }),
    ).rejects.toThrow(/VIN needs OCPP 2.1/);
  });
});

describe('chaos actions for OCPP 2.0.1', () => {
  it('offers no 2.1-only message and every other 2.x action', () => {
    const names201 = chaosActionsFor('ocpp2.0.1').map((a) => a.name);
    const names21 = chaosActionsFor('ocpp2.1').map((a) => a.name);
    const message = (n: string): string => (n.startsWith('send') ? n.slice(4) : n);
    const dropped = names21.filter((n) => !names201.includes(n)).map(message);
    expect(dropped.length).toBeGreaterThan(0);
    for (const m of dropped) expect(isOcpp201Message(m), m).toBe(false);
    for (const n of names201) {
      if (n.startsWith('send')) expect(isOcpp201Message(message(n)), n).toBe(true);
    }
    expect(chaosActionsFor('ocpp1.6').map((a) => a.name)).not.toContain('sendNotifyEvent');
  });

  it('sends every 2.0.1 chaos message as a valid 2.0.1 request', async () => {
    const h = await liveHarness('ocpp2.0.1');
    const manager = new SimulatorManager(stubSql());
    manager.simulators.set(h.sim.stationId, h.sim);
    const sendActions = chaosActionsFor('ocpp2.0.1').filter((a) => a.name.startsWith('send'));
    expect(sendActions.length).toBeGreaterThan(15);
    for (const action of sendActions) {
      const done = manager.handleCommand(
        JSON.stringify({
          stationId: h.sim.stationId,
          action: action.name,
          params: action.params([]),
        }),
      );
      await settle(5000);
      await done;
    }
    expect(h.violations).toEqual([]);
    const sent = new Set(h.actions());
    for (const action of sendActions) {
      const message = action.name.slice(4);
      // The station sends GetTransactionStatus only to a 2.0.1 peer that defines it.
      if (isOcpp201Message(message)) expect(sent, message).toContain(message);
    }
  });
});
