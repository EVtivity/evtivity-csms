// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { collectMessages, setVariables, sleep } from '../../../../cs-test-helpers.js';
import {
  componentEvse,
  componentName,
  CONNECTOR_ID,
  describeEvent,
  energyTransferStarted,
  EVSE_ID,
  monitoringMemoryState,
  monitorStep,
  setMonitor,
  TOKEN,
  useCsmsHandler,
  variableName,
  waitForEvent,
} from './monitoring-shared.js';

/** <Configured threshold monitor component variable> EVSE.Power trigger values (W). */
const UPPER_THRESHOLD_W = 1000;
const LOWER_THRESHOLD_W = 100;
/** <Configured Transaction Duration> (seconds). */
const TRANSACTION_DURATION_S = 3;

const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');

export const TC_N_20_CS: CsTestCase = {
  id: 'TC_N_20_CS',
  name: 'Alert Event - Threshold value exceeded',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'A monitored variable exceeds a threshold monitor and causes a NotifyEventRequest.',
  purpose: 'To test that Charging Station supports threshold monitors.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const powerComponent = { name: 'EVSE', evse: { id: EVSE_ID } };

    // Memory State: MonitoringBase All, UpperThreshold monitor on EVSE.Power, MonitoringLevel 8
    await monitoringMemoryState(ctx, steps);
    const upper = await setMonitor(ctx.server, {
      type: 'UpperThreshold',
      value: UPPER_THRESHOLD_W,
      severity: 5,
      component: powerComponent,
      variable: 'Power',
    });
    steps.push(monitorStep(0, 'Before: UpperThreshold monitor on EVSE.Power', upper));
    const lvl = await ctx.server.sendCommand('SetMonitoringLevel', { severity: 8 });
    steps.push({
      step: 0,
      description: 'Before: SetMonitoringLevel 8',
      status: passOrFail(lvl['status'] === 'Accepted'),
      expected: 'status Accepted',
      actual: `status ${String(lvl['status'])}`,
    });
    const id1 = upper['id'] as number;

    // Step 1-3: EnergyTransferStarted triggers the monitor
    const txId = await energyTransferStarted(ctx, steps);
    if (txId == null) return { status: 'failed', durationMs: 0, steps };
    const exceeded = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === id1,
      20_000,
    );
    const e1 = exceeded?.event;
    steps.push({
      step: 2,
      description: 'NotifyEventRequest: Power exceeding the upper threshold',
      status: passOrFail(
        exceeded != null &&
          exceeded.request['seqNo'] === 0 &&
          exceeded.request['generatedAt'] != null &&
          e1?.['trigger'] === 'Alerting' &&
          Number(e1['actualValue']) > UPPER_THRESHOLD_W &&
          e1['cleared'] !== true &&
          e1['transactionId'] === txId &&
          componentName(e1) === 'EVSE' &&
          variableName(e1) === 'Power',
      ),
      expected: `seqNo 0, trigger Alerting, actualValue > ${String(UPPER_THRESHOLD_W)}, not cleared, transactionId ${txId}, monitor ${String(id1)}, EVSE/Power`,
      actual: describeEvent(exceeded),
    });

    // Step 4-5: a LowerThreshold monitor that is not exceeded while charging
    const lower = await setMonitor(ctx.server, {
      type: 'LowerThreshold',
      value: LOWER_THRESHOLD_W,
      severity: 5,
      component: powerComponent,
      variable: 'Power',
    });
    steps.push(monitorStep(5, 'SetVariableMonitoringResponse LowerThreshold: Accepted', lower));
    const id2 = lower['id'] as number;

    // Step 6: Reusable State StopAuthorized (present the same idToken)
    await ctx.station.authorize(EVSE_ID, TOKEN);

    // Step 7: the upper threshold clears and the lower threshold is exceeded
    const found = new Map<number, Record<string, unknown>>();
    const deadline = Date.now() + 15_000;
    while (found.size < 2 && Date.now() < deadline) {
      const next = await waitForEvent(
        ctx.server,
        (e) =>
          (e['variableMonitoringId'] === id1 && e['cleared'] === true) ||
          (e['variableMonitoringId'] === id2 && e['cleared'] !== true),
        deadline - Date.now(),
      );
      if (next == null) break;
      found.set(next.event['variableMonitoringId'] as number, next.event);
    }
    const cleared = found.get(id1);
    steps.push({
      step: 7,
      description: 'NotifyEventRequest: returning below the upper threshold (cleared)',
      status: passOrFail(
        cleared != null &&
          cleared['trigger'] === 'Alerting' &&
          Number(cleared['actualValue']) <= UPPER_THRESHOLD_W &&
          cleared['transactionId'] === txId &&
          cleared['eventNotificationType'] === 'CustomMonitor' &&
          componentName(cleared) === 'EVSE' &&
          variableName(cleared) === 'Power',
      ),
      expected: `monitor ${String(id1)}, trigger Alerting, cleared true, actualValue <= ${String(UPPER_THRESHOLD_W)}, CustomMonitor`,
      actual: cleared == null ? 'not received' : JSON.stringify(cleared),
    });
    const below = found.get(id2);
    steps.push({
      step: 7,
      description: 'NotifyEventRequest: dropping below the lower threshold',
      status: passOrFail(
        below != null &&
          below['trigger'] === 'Alerting' &&
          Number(below['actualValue']) < LOWER_THRESHOLD_W &&
          below['transactionId'] === txId &&
          below['eventNotificationType'] === 'CustomMonitor' &&
          componentName(below) === 'EVSE' &&
          variableName(below) === 'Power',
      ),
      expected: `monitor ${String(id2)}, trigger Alerting, not cleared, actualValue < ${String(LOWER_THRESHOLD_W)}, CustomMonitor`,
      actual: below == null ? 'not received' : JSON.stringify(below),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_21_CS: CsTestCase = {
  id: 'TC_N_21_CS',
  name: 'Alert Event - Caused by hardwired trigger',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'An event that is hardwired in the firmware is reported.',
  purpose: 'To test that Charging Station reports this as a HardWiredNotification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);

    // Tester triggers a hardwired notification: the connector plug retention
    // lock fails (ConnectorPlugRetentionLock.Problem).
    await ctx.station.simulateLockFailure(EVSE_ID, CONNECTOR_ID);
    const found = await waitForEvent(
      ctx.server,
      (e) => e['eventNotificationType'] === 'HardWiredNotification',
      10_000,
    );
    steps.push({
      step: 1,
      description: 'NotifyEventRequest with eventNotificationType HardWiredNotification',
      status: passOrFail(
        found != null && found.request['seqNo'] === 0 && found.request['generatedAt'] != null,
      ),
      expected: 'generatedAt set, seqNo 0, eventNotificationType HardWiredNotification',
      actual: describeEvent(found),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_22_CS: CsTestCase = {
  id: 'TC_N_22_CS',
  name: 'Offline Notification - Queued (severity equal or lower)',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging Station queues event notifications when offline.',
  purpose:
    'To test that Charging Station will queue event notifications with a severity equal or lower than OfflineMonitoringEventQueuingSeverity.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const severity = 5; // <Configured Severity>

    // Configuration State: MonitoringCtrlr.OfflineQueuingSeverity
    const notAccepted = await setVariables(ctx.server, [
      { component: 'MonitoringCtrlr', variable: 'OfflineQueuingSeverity', value: String(severity) },
    ]);
    steps.push({
      step: 0,
      description: 'Before: MonitoringCtrlr.OfflineQueuingSeverity',
      status: passOrFail(notAccepted.length === 0),
      expected: 'Accepted',
      actual: notAccepted.length === 0 ? 'Accepted' : notAccepted.join(', '),
    });
    // Memory State: custom monitor on the EVSE AvailabilityState with severity = <Configured severity>
    const monitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity,
      component: { name: 'EVSE', evse: { id: EVSE_ID } },
      variable: 'AvailabilityState',
    });
    steps.push(monitorStep(0, 'Before: Delta monitor on EVSE.AvailabilityState', monitor));

    // Take the Charging Station offline, then plug a cable (step 1-2: queued)
    ctx.server.disconnectStation(true);
    await sleep(500);
    await ctx.station.plugIn(EVSE_ID);
    await sleep(TRANSACTION_DURATION_S * 1000);

    // Bring the Charging Station back online
    ctx.server.acceptConnections();
    try {
      await ctx.server.waitForConnection(90_000);
    } catch {
      steps.push({
        step: 3,
        description: 'Charging Station reconnects',
        status: 'failed',
        expected: 'connection restored',
        actual: 'no reconnection within 90 s',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 3: the queued NotifyEventRequest
    const found = await waitForEvent(
      ctx.server,
      (e) =>
        componentName(e) === 'EVSE' &&
        variableName(e) === 'AvailabilityState' &&
        e['variableMonitoringId'] === monitor['id'],
      20_000,
    );
    const e = found?.event;
    steps.push({
      step: 3,
      description: 'Queued NotifyEventRequest for EVSE AvailabilityState Occupied',
      status: passOrFail(
        e != null &&
          e['trigger'] === 'Delta' &&
          e['actualValue'] === 'Occupied' &&
          componentEvse(e)?.id === EVSE_ID,
      ),
      expected: `trigger Delta, actualValue Occupied, EVSE ${String(EVSE_ID)}, AvailabilityState`,
      actual: describeEvent(found),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_23_CS: CsTestCase = {
  id: 'TC_N_23_CS',
  name: 'Offline Notification - Not queued (severity higher)',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging Station does not queue event notifications when offline.',
  purpose:
    'To test that Charging Station does not queue event notifications with a severity higher than OfflineMonitoringEventQueuingSeverity.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const severity = 2; // <Configured Severity>

    const notAccepted = await setVariables(ctx.server, [
      { component: 'MonitoringCtrlr', variable: 'OfflineQueuingSeverity', value: String(severity) },
    ]);
    steps.push({
      step: 0,
      description: 'Before: MonitoringCtrlr.OfflineQueuingSeverity',
      status: passOrFail(notAccepted.length === 0),
      expected: 'Accepted',
      actual: notAccepted.length === 0 ? 'Accepted' : notAccepted.join(', '),
    });
    // Memory State: monitors on the EVSE and Connector AvailabilityState, severity + 1
    const evseMonitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: severity + 1,
      component: { name: 'EVSE', evse: { id: EVSE_ID } },
      variable: 'AvailabilityState',
    });
    steps.push(monitorStep(0, 'Before: Delta monitor on EVSE.AvailabilityState', evseMonitor));
    const connectorMonitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: severity + 1,
      component: { name: 'Connector', evse: { id: EVSE_ID, connectorId: CONNECTOR_ID } },
      variable: 'AvailabilityState',
    });
    steps.push(
      monitorStep(0, 'Before: Delta monitor on Connector.AvailabilityState', connectorMonitor),
    );

    // Manual Action: Connect the EV and EVSE. Step 1: Connector and EVSE notifications
    await ctx.station.plugIn(EVSE_ID);
    const connectorEvent = await waitForEvent(
      ctx.server,
      (e) =>
        componentName(e) === 'Connector' &&
        variableName(e) === 'AvailabilityState' &&
        e['trigger'] === 'Delta' &&
        e['actualValue'] === 'Occupied',
      10_000,
    );
    steps.push({
      step: 1,
      description: 'NotifyEventRequest: Connector AvailabilityState Occupied',
      status: passOrFail(
        connectorEvent != null &&
          componentEvse(connectorEvent.event)?.id === EVSE_ID &&
          componentEvse(connectorEvent.event)?.connectorId === CONNECTOR_ID,
      ),
      expected: `trigger Delta, Occupied, Connector EVSE ${String(EVSE_ID)} connector ${String(CONNECTOR_ID)}`,
      actual: describeEvent(connectorEvent),
    });
    const evseEvent = await waitForEvent(
      ctx.server,
      (e) =>
        componentName(e) === 'EVSE' &&
        variableName(e) === 'AvailabilityState' &&
        e['trigger'] === 'Delta' &&
        e['actualValue'] === 'Occupied',
      10_000,
    );
    steps.push({
      step: 1,
      description: 'NotifyEventRequest: EVSE AvailabilityState Occupied',
      status: passOrFail(evseEvent != null && componentEvse(evseEvent.event)?.id === EVSE_ID),
      expected: `trigger Delta, Occupied, EVSE ${String(EVSE_ID)}`,
      actual: describeEvent(evseEvent),
    });
    // Steps 3-8 apply when TxStartPoint contains EVConnected or ParkingBayOccupancy;
    // the simulator's TxStartPoint is PowerPathClosed (PICS C-09.4).

    // Take offline, disconnect and reconnect the EV, wait, bring back online
    ctx.server.disconnectStation(true);
    await sleep(500);
    await ctx.station.unplug(EVSE_ID);
    await ctx.station.plugIn(EVSE_ID);
    await sleep(TRANSACTION_DURATION_S * 1000);
    ctx.server.acceptConnections();
    try {
      await ctx.server.waitForConnection(90_000);
    } catch {
      steps.push({
        step: 5,
        description: 'Charging Station reconnects',
        status: 'failed',
        expected: 'connection restored',
        actual: 'no reconnection within 90 s',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    // The CS shall not send a NotifyEventRequest for AvailabilityState of the EVSE and Connector.
    const after = await collectMessages(ctx.server, 'NotifyEvent', 8000, 15_000);
    const availability = after
      .flatMap((r) => (r['eventData'] ?? []) as Array<Record<string, unknown>>)
      .filter(
        (e) =>
          variableName(e) === 'AvailabilityState' &&
          (componentName(e) === 'EVSE' || componentName(e) === 'Connector') &&
          componentEvse(e)?.id === EVSE_ID,
      );
    steps.push({
      step: 5,
      description: 'No NotifyEventRequest for AvailabilityState of the EVSE and Connector',
      status: passOrFail(availability.length === 0),
      expected: 'none',
      actual:
        availability.length === 0
          ? 'none'
          : availability
              .map((e) => `${String(componentName(e))}=${String(e['actualValue'])}`)
              .join(', '),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_N_45_CS: CsTestCase = {
  id: 'TC_N_45_CS',
  name: 'Alert Event - Delta value exceeded',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'NotifyEventRequest reports every Component/Variable for which a VariableMonitoring setting was triggered.',
  purpose:
    'To verify if the Charging station is correctly communicating when a delta value has exceeded.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);

    // Memory State: Delta monitor on EVSE.Power (value 100.0), MonitoringLevel 8
    const monitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 100,
      severity: 5,
      component: { name: 'EVSE', evse: { id: EVSE_ID } },
      variable: 'Power',
    });
    steps.push(monitorStep(0, 'Before: Delta monitor on EVSE.Power', monitor));
    const lvl = await ctx.server.sendCommand('SetMonitoringLevel', { severity: 8 });
    steps.push({
      step: 0,
      description: 'Before: SetMonitoringLevel 8',
      status: passOrFail(lvl['status'] === 'Accepted'),
      expected: 'status Accepted',
      actual: `status ${String(lvl['status'])}`,
    });

    // Step 1: EnergyTransferStarted triggers the monitor
    const txId = await energyTransferStarted(ctx, steps);
    if (txId == null) return { status: 'failed', durationMs: 0, steps };
    const found = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      20_000,
    );
    const e = found?.event;
    steps.push({
      step: 2,
      description: 'NotifyEventRequest: trigger Delta for EVSE.Power from the monitor',
      status: passOrFail(
        e != null &&
          e['trigger'] === 'Delta' &&
          componentName(e) === 'EVSE' &&
          variableName(e) === 'Power',
      ),
      expected: `trigger Delta, EVSE/Power, variableMonitoringId ${String(monitor['id'])}`,
      actual: describeEvent(found),
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
