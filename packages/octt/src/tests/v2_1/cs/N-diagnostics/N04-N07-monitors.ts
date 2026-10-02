// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import { collectMessages, setVariables, sleep } from '../../../../cs-test-helpers.js';
import {
  componentName,
  describeEvent,
  energyTransferStarted,
  EVSE_ID,
  setMonitor,
  TOKEN,
  useCsmsHandler,
  variableName,
  waitForEvent,
} from './monitoring-shared.js';

const MODULE = 'N-diagnostics';
/** <Configured severity>. */
const SEVERITY = 5;
/** <Configured threshold monitor component variable>: EVSE Power (W). */
const POWER = { component: { name: 'EVSE', evse: { id: EVSE_ID } }, variable: 'Power' };
/** <Configured non-numeric delta component variable>: EVSE AvailabilityState. */
const AVAILABILITY = {
  component: { name: 'EVSE', evse: { id: EVSE_ID } },
  variable: 'AvailabilityState',
};
/** <Configured Clock Aligned MeterValues Interval> (seconds) for the periodic monitor. */
const PERIODIC_INTERVAL_S = 3;

const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');
const result = (steps: StepResult[]): TestResult => ({
  status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
  durationMs: 0,
  steps,
});

const create = (
  id: string,
  name: string,
  purpose: string,
  execute: (ctx: CsTestContext) => Promise<TestResult>,
  extra: Partial<CsTestCase> = {},
): CsTestCase => ({
  id,
  name,
  module: MODULE,
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sets variable monitors on the Charging Station, which reports monitoring events and reports.',
  purpose,
  execute,
  ...extra,
});

type Result = Record<string, unknown>;
const comp = (r: Result | undefined): Record<string, unknown> | undefined =>
  r?.['component'] as Record<string, unknown> | undefined;
const varName = (r: Result | undefined): unknown =>
  (r?.['variable'] as Record<string, unknown> | undefined)?.['name'];

async function setMonitoringLevel(ctx: CsTestContext, steps: StepResult[], level: number) {
  const resp = await ctx.server.sendCommand('SetMonitoringLevel', { severity: level });
  steps.push({
    step: 0,
    description: `Before: SetMonitoringLevel ${String(level)}`,
    status: passOrFail(resp['status'] === 'Accepted'),
    expected: 'Accepted',
    actual: String(resp['status']),
  });
}

function acceptedStep(step: number, description: string, r: Result): StepResult {
  return {
    step,
    description,
    status: passOrFail(r['status'] === 'Accepted' && typeof r['id'] === 'number'),
    expected: 'status Accepted with id',
    actual: `status ${String(r['status'])}, id ${String(r['id'])}`,
  };
}

/** GetMonitoringReportRequest and every NotifyMonitoringReportRequest part of it. */
async function monitoringReport(
  ctx: CsTestContext,
  request: Record<string, unknown>,
): Promise<{ status: unknown; monitors: Array<Record<string, unknown>> }> {
  const requestId = Math.floor(Math.random() * 1_000_000);
  const resp = await ctx.server.sendCommand('GetMonitoringReport', { requestId, ...request });
  const monitors: Array<Record<string, unknown>> = [];
  if (resp['status'] === 'Accepted') {
    for (;;) {
      let part: Record<string, unknown>;
      try {
        part = await ctx.server.waitForMessage('NotifyMonitoringReport', 10_000);
      } catch {
        break;
      }
      if (part['requestId'] !== requestId) continue;
      monitors.push(...((part['monitor'] ?? []) as Array<Record<string, unknown>>));
      if (part['tbc'] !== true) break;
    }
  }
  return { status: resp['status'], monitors };
}

const monitoringOf = (m: Record<string, unknown>): Array<Record<string, unknown>> =>
  (m['variableMonitoring'] ?? []) as Array<Record<string, unknown>>;

export const TC_N_15_CS = create(
  'TC_N_15_CS',
  'Set Variable Monitoring - Duplicate Variable type/severity combination',
  'To test that the Charging Station rejects a second monitor with the same type and severity on a variable.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const data = {
      value: 1,
      type: 'Delta',
      severity: SEVERITY,
      component: AVAILABILITY.component,
      variable: { name: AVAILABILITY.variable },
    };
    const resp = await ctx.server.sendCommand('SetVariableMonitoring', {
      setMonitoringData: [data, data],
    });
    const results = (resp['setMonitoringResult'] ?? []) as Result[];
    const accepted = results.find((r) => r['status'] === 'Accepted');
    const duplicate = results.find((r) => r['status'] === 'Duplicate');
    const matches = (r: Result | undefined): boolean =>
      r?.['type'] === 'Delta' &&
      r['severity'] === SEVERITY &&
      comp(r)?.['name'] === 'EVSE' &&
      (comp(r)?.['evse'] as { id?: number } | undefined)?.id === EVSE_ID &&
      varName(r) === 'AvailabilityState';
    steps.push({
      step: 2,
      description: 'One result Accepted with an id, the other Duplicate',
      status: passOrFail(
        matches(accepted) &&
          typeof accepted?.['id'] === 'number' &&
          matches(duplicate) &&
          results.length === 2,
      ),
      expected: 'Accepted (with id) and Duplicate, Delta, EVSE AvailabilityState',
      actual: JSON.stringify(results),
    });
    return result(steps);
  },
);

export const TC_N_24_CS = create(
  'TC_N_24_CS',
  'Set Variable Monitoring - Periodic event',
  'To test that the Charging Station reports a periodic monitor with NotifyEvent.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await setMonitoringLevel(ctx, steps, 8);
    const r = await setMonitor(ctx.server, {
      type: 'Periodic',
      value: PERIODIC_INTERVAL_S,
      severity: 5,
      component: POWER.component,
      variable: POWER.variable,
    });
    steps.push({
      step: 2,
      description: 'SetVariableMonitoringResponse: Periodic monitor Accepted',
      status: passOrFail(
        r['status'] === 'Accepted' &&
          r['type'] === 'Periodic' &&
          r['severity'] === 5 &&
          comp(r)?.['name'] === 'EVSE' &&
          varName(r) === 'Power',
      ),
      expected: 'Accepted, Periodic, severity 5, EVSE Power',
      actual: JSON.stringify(r),
    });
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const found = await waitForEvent(
        ctx.server,
        (e) => e['variableMonitoringId'] === r['id'] && e['trigger'] === 'Periodic',
        (PERIODIC_INTERVAL_S + 3) * 1000,
      );
      if (found == null) break;
      if (componentName(found.event) !== 'EVSE' || variableName(found.event) !== 'Power') break;
      times.push(Date.now());
    }
    const gaps = times.slice(1).map((t, i) => (t - (times[i] ?? t)) / 1000);
    steps.push({
      step: 3,
      description: `NotifyEventRequest trigger Periodic for EVSE Power every ${String(PERIODIC_INTERVAL_S)} s`,
      status: passOrFail(
        times.length === 3 && gaps.every((g) => Math.abs(g - PERIODIC_INTERVAL_S) <= 1.5),
      ),
      expected: `3 events, ${String(PERIODIC_INTERVAL_S)} s apart`,
      actual: `${String(times.length)} events, gaps ${gaps.map((g) => g.toFixed(1)).join(', ')}`,
    });
    return result(steps);
  },
);

export const TC_N_37_CS = create(
  'TC_N_37_CS',
  'Set Variable Monitoring - Unknown Variable',
  'To verify that the Charging Station rejects a monitor on an unknown variable.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const r = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: SEVERITY,
      component: { name: 'EVSE' },
      variable: 'unknownVariable',
    });
    steps.push({
      step: 2,
      description: 'SetVariableMonitoringResponse: UnknownVariable',
      status: passOrFail(
        r['status'] === 'UnknownVariable' &&
          r['type'] === 'Delta' &&
          r['severity'] === SEVERITY &&
          comp(r)?.['name'] === 'EVSE' &&
          varName(r) === 'unknownVariable',
      ),
      expected: 'UnknownVariable, Delta, EVSE unknownVariable',
      actual: JSON.stringify(r),
    });
    return result(steps);
  },
);

export const TC_N_38_CS = create(
  'TC_N_38_CS',
  'Set Variable Monitoring - Not supported MonitorType',
  'To verify that the Charging Station rejects a monitor type it does not support for a variable.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const r = await setMonitor(ctx.server, {
      type: 'UpperThreshold',
      value: 1,
      severity: SEVERITY,
      component: AVAILABILITY.component,
      variable: AVAILABILITY.variable,
    });
    steps.push({
      step: 2,
      description: 'SetVariableMonitoringResponse: UnsupportedMonitorType or Rejected',
      status: passOrFail(
        (r['status'] === 'UnsupportedMonitorType' || r['status'] === 'Rejected') &&
          r['type'] === 'UpperThreshold' &&
          comp(r)?.['name'] === 'EVSE' &&
          varName(r) === 'AvailabilityState',
      ),
      expected: 'UnsupportedMonitorType or Rejected, UpperThreshold, EVSE AvailabilityState',
      actual: JSON.stringify(r),
    });
    return result(steps);
  },
);

export const TC_N_39_CS = create(
  'TC_N_39_CS',
  'Set Variable Monitoring - Component/Variable combination does NOT correspond',
  'To verify that the Charging Station rejects replacing a monitor with one for another component/variable.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const first = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: SEVERITY,
      component: AVAILABILITY.component,
      variable: AVAILABILITY.variable,
    });
    steps.push(acceptedStep(2, 'Delta monitor on EVSE AvailabilityState Accepted', first));
    const second = await setMonitor(ctx.server, {
      id: first['id'] as number,
      type: 'Delta',
      value: 1,
      severity: SEVERITY,
      component: POWER.component,
      variable: POWER.variable,
    });
    steps.push({
      step: 4,
      description: 'Replacing it with a monitor on EVSE Power: Rejected',
      status: passOrFail(
        second['status'] === 'Rejected' &&
          second['type'] === 'Delta' &&
          varName(second) === 'Power',
      ),
      expected: 'Rejected, Delta, EVSE Power',
      actual: JSON.stringify(second),
    });
    const report = await monitoringReport(ctx, {});
    steps.push({
      step: 6,
      description: 'GetMonitoringReportResponse Accepted',
      status: passOrFail(report.status === 'Accepted'),
      expected: 'Accepted',
      actual: String(report.status),
    });
    const kept = report.monitors.find((m) =>
      monitoringOf(m).some((vm) => vm['id'] === first['id']),
    );
    const vm = kept != null ? monitoringOf(kept).find((v) => v['id'] === first['id']) : undefined;
    steps.push({
      step: 7,
      description:
        'NotifyMonitoringReport keeps the original monitor (AvailabilityState, Delta, value 1)',
      status: passOrFail(
        kept != null &&
          comp(kept)?.['name'] === 'EVSE' &&
          varName(kept) === 'AvailabilityState' &&
          vm?.['value'] === 1 &&
          vm['type'] === 'Delta',
      ),
      expected: `monitor ${String(first['id'])} on EVSE AvailabilityState, Delta, value 1`,
      actual: kept == null ? 'not reported' : JSON.stringify(kept),
    });
    return result(steps);
  },
);

export const TC_N_40_CS = create(
  'TC_N_40_CS',
  'Set Variable Monitoring - Replace Variable Monitor',
  'To verify that the Charging Station replaces a monitor set with the same id.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const memory = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: 5,
      component: AVAILABILITY.component,
      variable: AVAILABILITY.variable,
    });
    steps.push(acceptedStep(0, 'Before: Delta monitor with severity 5', memory));
    const replaced = await setMonitor(ctx.server, {
      id: memory['id'] as number,
      type: 'Delta',
      value: 1,
      severity: 4,
      component: AVAILABILITY.component,
      variable: AVAILABILITY.variable,
    });
    steps.push({
      step: 2,
      description: 'SetVariableMonitoringResponse: Accepted for EVSE AvailabilityState',
      status: passOrFail(
        replaced['status'] === 'Accepted' &&
          replaced['type'] === 'Delta' &&
          comp(replaced)?.['name'] === 'EVSE' &&
          varName(replaced) === 'AvailabilityState',
      ),
      expected: 'Accepted, Delta, EVSE AvailabilityState',
      actual: JSON.stringify(replaced),
    });
    const report = await monitoringReport(ctx, {
      componentVariable: [
        { component: AVAILABILITY.component, variable: { name: AVAILABILITY.variable } },
      ],
      monitoringCriteria: ['DeltaMonitoring'],
    });
    steps.push({
      step: 4,
      description: 'GetMonitoringReportResponse Accepted',
      status: passOrFail(report.status === 'Accepted'),
      expected: 'Accepted',
      actual: String(report.status),
    });
    const vm = report.monitors.flatMap(monitoringOf).find((v) => v['id'] === memory['id']);
    steps.push({
      step: 5,
      description: 'NotifyMonitoringReport: the monitor has severity 4',
      status: passOrFail(vm?.['severity'] === 4),
      expected: 'severity 4',
      actual: vm == null ? 'not reported' : `severity ${String(vm['severity'])}`,
    });
    return result(steps);
  },
);

export const TC_N_43_CS = create(
  'TC_N_43_CS',
  'Set Variable Monitoring - First SetMonitoringData and third SetMonitoringData are valid, but the second contains an out of range value',
  'To verify that the Charging Station accepts the valid monitors of a request and rejects the out of range one.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const item = (type: string, value: number) => ({
      value,
      type,
      severity: SEVERITY,
      component: POWER.component,
      variable: { name: POWER.variable },
    });
    const resp = await ctx.server.sendCommand('SetVariableMonitoring', {
      setMonitoringData: [
        item('UpperThreshold', 1000),
        item('Delta', -1.0),
        item('LowerThreshold', 100),
      ],
    });
    const results = (resp['setMonitoringResult'] ?? []) as Result[];
    const byType = (t: string): Result | undefined => results.find((r) => r['type'] === t);
    steps.push({
      step: 2,
      description: 'UpperThreshold Accepted, Delta -1.0 Rejected, LowerThreshold Accepted',
      status: passOrFail(
        byType('UpperThreshold')?.['status'] === 'Accepted' &&
          byType('Delta')?.['status'] === 'Rejected' &&
          byType('LowerThreshold')?.['status'] === 'Accepted',
      ),
      expected: 'Accepted, Rejected, Accepted',
      actual: results.map((r) => `${String(r['type'])}=${String(r['status'])}`).join(', '),
    });
    return result(steps);
  },
);

export const TC_N_48_CS = create(
  'TC_N_48_CS',
  'Alert Event - Variable monitoring on write only',
  'To verify that the Charging Station reports a write-only variable change with an empty value.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    // Memory State: a Delta monitor on SecurityCtrlr.BasicAuthPassword
    const monitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: SEVERITY,
      component: { name: 'SecurityCtrlr' },
      variable: 'BasicAuthPassword',
    });
    steps.push(
      acceptedStep(0, 'Before: Delta monitor on SecurityCtrlr.BasicAuthPassword', monitor),
    );
    const notAccepted = await setVariables(ctx.server, [
      { component: 'SecurityCtrlr', variable: 'BasicAuthPassword', value: 'OCTTpassword0123456' },
    ]);
    steps.push({
      step: 2,
      description: 'SetVariablesResponse Accepted',
      status: passOrFail(notAccepted.length === 0),
      expected: 'Accepted or RebootRequired',
      actual: notAccepted.length === 0 ? 'Accepted' : notAccepted.join(', '),
    });
    const found = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      10_000,
    );
    steps.push({
      step: 4,
      description: 'NotifyEventRequest with an empty actualValue',
      status: passOrFail(found != null && found.event['actualValue'] === ''),
      expected: 'actualValue ""',
      actual: describeEvent(found),
    });
    return result(steps);
  },
  { stationConfig: { securityProfile: 1 } },
);

export const TC_N_51_CS = create(
  'TC_N_51_CS',
  'Set Variable Monitoring - Modifying a VariableMonitor and trigger',
  'To verify that a modified monitor triggers with its new value.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    // Memory State: UpperThreshold on EVSE Power with a value that charging does not reach
    const nonTrigger = 100_000;
    const monitor = await setMonitor(ctx.server, {
      type: 'UpperThreshold',
      value: nonTrigger,
      severity: 5,
      component: POWER.component,
      variable: POWER.variable,
    });
    steps.push(acceptedStep(0, 'Before: UpperThreshold monitor on EVSE Power', monitor));
    await setMonitoringLevel(ctx, steps, 8);
    const txId = await energyTransferStarted(ctx, steps);
    if (txId == null) return result(steps);
    const modified = await setMonitor(ctx.server, {
      id: monitor['id'] as number,
      type: 'UpperThreshold',
      value: 0,
      severity: 5,
      component: POWER.component,
      variable: POWER.variable,
    });
    steps.push({
      step: 3,
      description:
        'SetVariableMonitoringResponse: Accepted, UpperThreshold, severity 5, EVSE Power',
      status: passOrFail(
        modified['status'] === 'Accepted' &&
          modified['type'] === 'UpperThreshold' &&
          modified['severity'] === 5 &&
          comp(modified)?.['name'] === 'EVSE' &&
          varName(modified) === 'Power',
      ),
      expected: 'Accepted, UpperThreshold, severity 5, EVSE Power',
      actual: JSON.stringify(modified),
    });
    const found = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      15_000,
    );
    steps.push({
      step: 4,
      description: 'NotifyEventRequest: trigger Alerting, Power above the earlier value',
      status: passOrFail(
        found != null &&
          found.event['trigger'] === 'Alerting' &&
          Number(found.event['actualValue']) > 0,
      ),
      expected: 'trigger Alerting, actualValue > 0',
      actual: describeEvent(found),
    });
    return result(steps);
  },
);

export const TC_N_52_CS = create(
  'TC_N_52_CS',
  'Set Variable Monitoring - Removing a VariableMonitor',
  'To verify that a cleared monitor no longer reports.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const monitor = await setMonitor(ctx.server, {
      type: 'UpperThreshold',
      value: 0,
      severity: 5,
      component: POWER.component,
      variable: POWER.variable,
    });
    steps.push(acceptedStep(0, 'Before: UpperThreshold monitor on EVSE Power, value 0', monitor));
    await setMonitoringLevel(ctx, steps, 8);
    const txId = await energyTransferStarted(ctx, steps);
    if (txId == null) return result(steps);
    const alert = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      15_000,
    );
    steps.push({
      step: 1,
      description: 'NotifyEventRequest: trigger Alerting for the monitor',
      status: passOrFail(
        alert != null &&
          alert.event['trigger'] === 'Alerting' &&
          componentName(alert.event) === 'EVSE' &&
          variableName(alert.event) === 'Power',
      ),
      expected: 'trigger Alerting, EVSE Power',
      actual: describeEvent(alert),
    });
    const clear = await ctx.server.sendCommand('ClearVariableMonitoring', {
      id: [monitor['id']],
    });
    const cleared = ((clear['clearMonitoringResult'] ?? []) as Result[])[0];
    steps.push({
      step: 3,
      description: 'ClearVariableMonitoringResponse: Accepted for the monitor',
      status: passOrFail(cleared?.['status'] === 'Accepted' && cleared['id'] === monitor['id']),
      expected: `Accepted, id ${String(monitor['id'])}`,
      actual: JSON.stringify(cleared),
    });
    const report = await monitoringReport(ctx, {
      componentVariable: [{ component: POWER.component, variable: { name: POWER.variable } }],
      monitoringCriteria: ['ThresholdMonitoring'],
    });
    steps.push({
      step: 5,
      description: 'GetMonitoringReportResponse: EmptyResultSet',
      status: passOrFail(report.status === 'EmptyResultSet'),
      expected: 'EmptyResultSet',
      actual: String(report.status),
    });
    // Step 6: StopAuthorized
    await ctx.station.authorize(EVSE_ID, TOKEN);
    const after = await collectMessages(ctx.server, 'NotifyEvent', 3000, 6000);
    const forMonitor = after
      .flatMap((r) => (r['eventData'] ?? []) as Result[])
      .filter((e) => e['variableMonitoringId'] === monitor['id']);
    steps.push({
      step: 6,
      description: 'No NotifyEventRequest for the cleared monitor',
      status: passOrFail(forMonitor.length === 0),
      expected: 'none',
      actual: `${String(forMonitor.length)} event(s)`,
    });
    return result(steps);
  },
);

export const TC_N_53_CS = create(
  'TC_N_53_CS',
  'Alert Event - Persistant over reboot',
  'To verify that monitors persist over a reboot.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const monitor = await setMonitor(ctx.server, {
      type: 'UpperThreshold',
      value: 1000,
      severity: SEVERITY,
      component: POWER.component,
      variable: POWER.variable,
    });
    steps.push(acceptedStep(0, 'Before: UpperThreshold monitor on EVSE Power', monitor));
    // Reusable State Booted: reset the Charging Station
    const reset = await ctx.server.sendCommand('Reset', { type: 'Immediate' });
    steps.push({
      step: 0,
      description: 'Booted: ResetResponse Accepted',
      status: passOrFail(reset['status'] === 'Accepted'),
      expected: 'Accepted',
      actual: String(reset['status']),
    });
    let booted = true;
    try {
      await ctx.server.waitForMessage('BootNotification', 15_000);
    } catch {
      booted = false;
    }
    steps.push({
      step: 0,
      description: 'Booted: BootNotificationRequest',
      status: passOrFail(booted),
      expected: 'BootNotificationRequest',
      actual: booted ? 'received' : 'not received',
    });
    await sleep(1000);
    const report = await monitoringReport(ctx, { monitoringCriteria: ['ThresholdMonitoring'] });
    const vm = report.monitors.flatMap(monitoringOf).find((v) => v['id'] === monitor['id']);
    steps.push({
      step: 3,
      description: 'NotifyMonitoringReport after the reboot holds the UpperThreshold monitor',
      status: passOrFail(report.status === 'Accepted' && vm?.['type'] === 'UpperThreshold'),
      expected: `monitor ${String(monitor['id'])}, UpperThreshold`,
      actual: vm == null ? `status ${String(report.status)}, not reported` : JSON.stringify(vm),
    });
    return result(steps);
  },
);

export const TC_N_56_CS = create(
  'TC_N_56_CS',
  'Alert Event - Delta value NOT numeric exceeded',
  'To verify that a Delta monitor on a non-numeric variable reports a change.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const monitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 1,
      severity: 5,
      component: AVAILABILITY.component,
      variable: AVAILABILITY.variable,
    });
    steps.push(acceptedStep(0, 'Before: Delta monitor on EVSE AvailabilityState', monitor));
    await setMonitoringLevel(ctx, steps, 8);
    // Manual Action: change the AvailabilityState (connect the EV)
    await ctx.station.plugIn(EVSE_ID);
    const found = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      10_000,
    );
    steps.push({
      step: 1,
      description: 'NotifyEventRequest: trigger Delta for EVSE AvailabilityState',
      status: passOrFail(
        found != null &&
          found.event['trigger'] === 'Delta' &&
          componentName(found.event) === 'EVSE' &&
          variableName(found.event) === 'AvailabilityState',
      ),
      expected: `trigger Delta, EVSE AvailabilityState, monitor ${String(monitor['id'])}`,
      actual: describeEvent(found),
    });
    return result(steps);
  },
);

export const TC_N_61_CS = create(
  'TC_N_61_CS',
  'Alert Event - Variable monitoring on numeric',
  'To verify that a Delta monitor on a numeric variable reports only when the delta is reached.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const threshold = Number(
      ((
        (
          await ctx.server.sendCommand('GetVariables', {
            getVariableData: [
              { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'OfflineThreshold' } },
            ],
          })
        )['getVariableResult'] as Result[]
      )[0] ?? {})['attributeValue'] ?? NaN,
    );
    const monitor = await setMonitor(ctx.server, {
      type: 'Delta',
      value: 2,
      severity: SEVERITY,
      component: { name: 'OCPPCommCtrlr' },
      variable: 'OfflineThreshold',
    });
    steps.push(
      acceptedStep(0, 'Before: Delta monitor (2) on OCPPCommCtrlr.OfflineThreshold', monitor),
    );
    const set = async (value: number, step: number): Promise<void> => {
      const notAccepted = await setVariables(ctx.server, [
        { component: 'OCPPCommCtrlr', variable: 'OfflineThreshold', value: String(value) },
      ]);
      steps.push({
        step,
        description: `SetVariablesResponse OfflineThreshold ${String(value)}: Accepted`,
        status: passOrFail(notAccepted.length === 0),
        expected: 'Accepted',
        actual: notAccepted.length === 0 ? 'Accepted' : notAccepted.join(', '),
      });
    };
    await set(threshold + 1, 2);
    const early = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      3000,
    );
    steps.push({
      step: 3,
      description: 'No NotifyEventRequest while the delta is not exceeded',
      status: passOrFail(early == null),
      expected: 'none',
      actual: describeEvent(early),
    });
    await set(threshold + 2, 5);
    const found = await waitForEvent(
      ctx.server,
      (e) => e['variableMonitoringId'] === monitor['id'],
      10_000,
    );
    steps.push({
      step: 7,
      description: `NotifyEventRequest actualValue ${String(threshold + 2)}`,
      status: passOrFail(found != null && found.event['actualValue'] === String(threshold + 2)),
      expected: `actualValue ${String(threshold + 2)}`,
      actual: describeEvent(found),
    });
    return result(steps);
  },
);
