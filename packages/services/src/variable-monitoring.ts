// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, variableMonitoringRules } from '@evtivity/database';
import type { CommandResult } from './ocpp-command.js';

/** Who set a monitor: an operator through the monitoring rules route, or the low signal alert. */
export type MonitorRuleSource = 'operator' | 'low_signal';

export interface NewMonitorRule {
  stationId: string;
  component: string;
  componentInstance: string | null;
  variable: string;
  type: string;
  value: number;
  severity: number;
  source: MonitorRuleSource;
}

export type MonitorRuleRow = typeof variableMonitoringRules.$inferSelect;

/**
 * Stores a monitor as pending before SetVariableMonitoring is sent, so the
 * station's answer always finds its row. The insert of operator rules; the low
 * signal monitors insert theirs against their unique index (one per modem).
 */
export async function insertPendingMonitorRule(rule: NewMonitorRule): Promise<MonitorRuleRow> {
  const [row] = await db
    .insert(variableMonitoringRules)
    .values({
      stationId: rule.stationId,
      component: rule.component,
      componentInstance: rule.componentInstance,
      variable: rule.variable,
      type: rule.type,
      value: String(rule.value),
      severity: rule.severity,
      source: rule.source,
      status: 'pending',
    })
    .returning();
  if (row == null) throw new Error('Monitoring rule insert returned no row');
  return row;
}

/**
 * One SetMonitoringData item for a stored rule. `replaceId` replaces the
 * station's monitor with that id (N04.FR.12); without it the station creates
 * one and returns its id (N04.FR.11).
 */
export function setMonitoringDataItem(
  rule: Pick<
    MonitorRuleRow,
    'component' | 'componentInstance' | 'variable' | 'type' | 'value' | 'severity'
  >,
  replaceId?: number,
): Record<string, unknown> {
  return {
    ...(replaceId != null ? { id: replaceId } : {}),
    component: {
      name: rule.component,
      ...(rule.componentInstance != null ? { instance: rule.componentInstance } : {}),
    },
    variable: { name: rule.variable },
    type: rule.type,
    value: Number(rule.value),
    severity: rule.severity,
  };
}

/** The stored state of a variable monitoring rule after SetVariableMonitoring. */
export interface MonitorSetOutcome {
  status: 'active' | 'error';
  monitoringId: number | null;
  errorInfo: string | null;
}

function statusInfoText(entry: Record<string, unknown>): string | null {
  const info = entry.statusInfo as { reasonCode?: unknown; additionalInfo?: unknown } | undefined;
  if (info == null || typeof info.reasonCode !== 'string') return null;
  return typeof info.additionalInfo === 'string' && info.additionalInfo !== ''
    ? `${info.reasonCode} (${info.additionalInfo})`
    : info.reasonCode;
}

/**
 * Maps the station's SetVariableMonitoringResponse for one monitor to the rule
 * state: active with the monitor id the station assigned when the result is
 * Accepted (N04.FR.11), else error with the status and reason. A failed send
 * or no reply is an error too: the rule never stays pending.
 */
export function monitorSetOutcome(result: CommandResult): MonitorSetOutcome {
  if (result.timedOut === true) {
    return { status: 'error', monitoringId: null, errorInfo: 'No response from station' };
  }
  if (result.error != null) {
    return { status: 'error', monitoringId: null, errorInfo: result.error };
  }
  const results = result.response?.setMonitoringResult;
  const entry = Array.isArray(results) ? (results[0] as Record<string, unknown> | undefined) : null;
  return monitorResultOutcome(entry);
}

/** The rule state for one SetMonitoringResult entry of the station's reply. */
export function monitorResultOutcome(
  entry: Record<string, unknown> | null | undefined,
): MonitorSetOutcome {
  if (entry == null || typeof entry.status !== 'string') {
    return {
      status: 'error',
      monitoringId: null,
      errorInfo: 'Station reply has no setMonitoringResult',
    };
  }
  const reason = statusInfoText(entry);
  if (entry.status === 'Accepted') {
    if (typeof entry.id === 'number' && Number.isInteger(entry.id)) {
      return { status: 'active', monitoringId: entry.id, errorInfo: null };
    }
    // N04.FR.11: an Accepted result carries the id. Without it the monitor
    // cannot be cleared later, so the rule is not marked active.
    return {
      status: 'error',
      monitoringId: null,
      errorInfo: 'Station accepted the monitor without a monitor id',
    };
  }
  return {
    status: 'error',
    monitoringId: null,
    errorInfo: reason != null ? `${entry.status}: ${reason}` : entry.status,
  };
}

/** What ClearVariableMonitoring did to one monitor on the station. */
export type MonitorClearOutcome =
  | { kind: 'cleared' }
  | { kind: 'rejected'; errorInfo: string }
  | { kind: 'failed'; timedOut: boolean; errorInfo: string };

/**
 * Maps the station's ClearVariableMonitoringResponse for one monitor id.
 * Accepted and NotFound (N06.FR.02, the station no longer has it) both mean the
 * monitor is gone. Rejected (a monitor that cannot be cleared, N06.FR.03) keeps it.
 */
export function monitorClearOutcome(
  result: CommandResult,
  monitoringId: number,
): MonitorClearOutcome {
  if (result.timedOut === true) {
    return { kind: 'failed', timedOut: true, errorInfo: 'No response from station' };
  }
  if (result.error != null) {
    return { kind: 'failed', timedOut: false, errorInfo: result.error };
  }
  const results = result.response?.clearMonitoringResult;
  const list = Array.isArray(results) ? (results as Array<Record<string, unknown>>) : [];
  const entry = list.find((r) => r.id === monitoringId) ?? list[0];
  if (entry == null || typeof entry.status !== 'string') {
    return {
      kind: 'failed',
      timedOut: false,
      errorInfo: 'Station reply has no clearMonitoringResult',
    };
  }
  if (entry.status === 'Accepted' || entry.status === 'NotFound') return { kind: 'cleared' };
  const reason = statusInfoText(entry);
  return {
    kind: 'rejected',
    errorInfo: reason != null ? `${entry.status}: ${reason}` : entry.status,
  };
}
