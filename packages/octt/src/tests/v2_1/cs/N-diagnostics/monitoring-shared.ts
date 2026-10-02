// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestContext, StepResult } from '../../../../cs-types.js';
import type { OcppTestServer } from '../../../../cs-server.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

export const TOKEN = 'OCTT-TOKEN-001';
/** <Configured evseId> / <Configured connectorId>. */
export const EVSE_ID = 1;
export const CONNECTOR_ID = 1;

/** Answers station-initiated messages like the Test System (CSMS role). */
export function useCsmsHandler(
  ctx: CsTestContext,
  overrides: Record<string, Record<string, unknown>> = {},
): void {
  ctx.server.setMessageHandler(async (action: string) => {
    const override = overrides[action];
    if (override != null) return override;
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });
}

export interface MonitorSpec {
  id?: number | undefined;
  type: string;
  value: number;
  severity: number;
  component: Record<string, unknown>;
  variable: string;
  periodicEventStream?: { interval?: number; values?: number } | undefined;
}

/** SetVariableMonitoringRequest with one monitor; returns the setMonitoringResult. */
export async function setMonitor(
  server: OcppTestServer,
  spec: MonitorSpec,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    value: spec.value,
    type: spec.type,
    severity: spec.severity,
    component: spec.component,
    variable: { name: spec.variable },
  };
  if (spec.id != null) data['id'] = spec.id;
  if (spec.periodicEventStream != null) data['periodicEventStream'] = spec.periodicEventStream;
  const resp = await server.sendCommand('SetVariableMonitoring', { setMonitoringData: [data] });
  const results = (resp['setMonitoringResult'] ?? []) as Array<Record<string, unknown>>;
  return results[0] ?? {};
}

/** Step for a SetVariableMonitoringResponse that must be Accepted. */
export function monitorStep(
  step: number,
  description: string,
  result: Record<string, unknown>,
): StepResult {
  return {
    step,
    description,
    status:
      result['status'] === 'Accepted' && typeof result['id'] === 'number' ? 'passed' : 'failed',
    expected: 'setMonitoringResult status Accepted with id',
    actual: `status ${String(result['status'])}, id ${String(result['id'])}`,
  };
}

/** Memory State: SetMonitoringBase All and SetMonitoringLevel. */
export async function monitoringMemoryState(
  ctx: CsTestContext,
  steps: StepResult[],
  level?: number,
): Promise<void> {
  const base = await ctx.server.sendCommand('SetMonitoringBase', { monitoringBase: 'All' });
  steps.push({
    step: 0,
    description: 'Before: SetMonitoringBaseRequest monitoringBase All',
    status: base['status'] === 'Accepted' ? 'passed' : 'failed',
    expected: 'status Accepted',
    actual: `status ${String(base['status'])}`,
  });
  if (level == null) return;
  const lvl = await ctx.server.sendCommand('SetMonitoringLevel', { severity: level });
  steps.push({
    step: 0,
    description: `Before: SetMonitoringLevelRequest severity ${String(level)}`,
    status: lvl['status'] === 'Accepted' ? 'passed' : 'failed',
    expected: 'status Accepted',
    actual: `status ${String(lvl['status'])}`,
  });
}

/** Reusable State EnergyTransferStarted; returns the transactionId or null. */
export async function energyTransferStarted(
  ctx: CsTestContext,
  steps: StepResult[],
): Promise<string | null> {
  await ctx.station.plugIn(EVSE_ID);
  await ctx.station.authorize(EVSE_ID, TOKEN);
  const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
  const txId =
    ((charging?.['transactionInfo'] as Record<string, unknown> | undefined)?.['transactionId'] as
      | string
      | undefined) ?? null;
  steps.push({
    step: 0,
    description: 'Reusable State EnergyTransferStarted',
    status: txId != null ? 'passed' : 'failed',
    expected: 'TransactionEventRequest with chargingState Charging',
    actual: txId != null ? `transactionId ${txId}` : 'not received',
  });
  return txId;
}

export interface FoundEvent {
  request: Record<string, unknown>;
  event: Record<string, unknown>;
}

/**
 * Wait for a NotifyEventRequest that holds an eventData element matching
 * `match`. Other NotifyEventRequests are passed over (OCTT: "Other eventData
 * elements can be ignored").
 */
export async function waitForEvent(
  server: OcppTestServer,
  match: (event: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<FoundEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let request: Record<string, unknown>;
    try {
      request = await server.waitForMessage('NotifyEvent', deadline - Date.now());
    } catch {
      return null;
    }
    const events = (request['eventData'] ?? []) as Array<Record<string, unknown>>;
    const event = events.find(match);
    if (event != null) return { request, event };
  }
  return null;
}

export const componentName = (event: Record<string, unknown>): unknown =>
  (event['component'] as Record<string, unknown> | undefined)?.['name'];
export const componentEvse = (
  event: Record<string, unknown>,
): { id?: number; connectorId?: number } | undefined =>
  (event['component'] as Record<string, unknown> | undefined)?.['evse'] as
    | { id?: number; connectorId?: number }
    | undefined;
export const variableName = (event: Record<string, unknown>): unknown =>
  (event['variable'] as Record<string, unknown> | undefined)?.['name'];

export const describeEvent = (found: FoundEvent | null): string => {
  if (found == null) return 'not received';
  const e = found.event;
  return `trigger ${String(e['trigger'])}, actualValue ${String(e['actualValue'])}, cleared ${String(e['cleared'])}, monitor ${String(e['variableMonitoringId'])}, type ${String(e['eventNotificationType'])}, tx ${String(e['transactionId'])}, ${String(componentName(e))}/${String(variableName(e))}, seqNo ${String(found.request['seqNo'])}`;
};
