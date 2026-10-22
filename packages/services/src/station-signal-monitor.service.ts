// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The low signal monitors of the SIM settings (`sim.signal.alertBelowDbm`): a
 * LowerThreshold monitor on each DataLink.SignalStrength the station can
 * monitor, so the station reports a weak signal with NotifyEvent. This is
 * configuration, not a read. The only creator and remover of the monitors
 * (`variable_monitoring_rules.source = 'low_signal'`); nothing runs while
 * station signal reads are off and no such monitor is stored.
 */

import { randomInt } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  chargingStations,
  db,
  getSimGeneralSettings,
  inOperatorStation,
  isOperatorStation,
  stationConfigurations,
  variableMonitoringRules,
} from '@evtivity/database';
import {
  isOcpp2x,
  publishOcppCommand,
  readSignalStrength,
  type PubSubClient,
  type ServiceLogger,
  type SimGeneralSettings,
} from '@evtivity/lib';
import {
  monitorResultOutcome,
  setMonitoringDataItem,
  type MonitorRuleRow,
} from './variable-monitoring.js';

export const LOW_SIGNAL_SOURCE = 'low_signal';
export const LOW_SIGNAL_COMPONENT = 'DataLink';
export const LOW_SIGNAL_VARIABLE = 'SignalStrength';
export const LOW_SIGNAL_TYPE = 'LowerThreshold';
/** OCPP severity 6 (Warning): a weak signal needs attention, nothing is broken yet. */
export const LOW_SIGNAL_SEVERITY = 6;

const ASU_MAX = 31;

/** How long a read the station accepted may wait for its NotifyMonitoringReport. */
export const LOW_SIGNAL_READ_TTL_MS = 5 * 60_000;
const READ_EXPIRED = 'GetMonitoringReport: no report within 5 minutes';

export interface SignalMonitorStation {
  /** charging_stations.id */
  id: string;
  /** The OCPP identity. */
  stationId: string;
  ocppProtocol: string | null;
  isOnline: boolean;
}

export interface SignalMonitorDeps {
  pubsub: PubSubClient;
  log: ServiceLogger;
}

export interface SignalMonitorSyncResult {
  set: number;
  cleared: number;
}

type SignalSettings = Pick<SimGeneralSettings, 'stationSignalEnabled' | 'signalAlertBelowDbm'>;

/**
 * The monitor threshold in the station's unit: dBm (dBm, dBmW), or ASU (0 to
 * 31) for a modem reporting ASU. Without a unit it follows the value's range.
 * Null for a unit it does not know: such a value is never taken for dBm.
 */
export function lowSignalThreshold(
  alertBelowDbm: number,
  reported: { unit: string | null; value: string | null },
): number | null {
  const unit = reported.unit?.trim().toLowerCase() ?? '';
  const inferredAsu = unit === '' && readSignalStrength(reported.value, null)?.unit === 'ASU';
  if (unit === 'asu' || inferredAsu) {
    return Math.min(ASU_MAX, Math.max(0, Math.round((alertBelowDbm + 113) / 2)));
  }
  if (unit === '' || unit === 'dbm' || unit === 'dbmw') return alertBelowDbm;
  return null;
}

function lowSignalWanted(settings: SignalSettings): settings is SignalSettings & {
  signalAlertBelowDbm: number;
} {
  return settings.stationSignalEnabled && settings.signalAlertBelowDbm != null;
}

/**
 * The DataLink signal variables of a station that its NotifyReport marked
 * monitorable. A conformance test station gets none: an unasked monitor would
 * break its test.
 */
async function monitorableSignals(
  stationUuid: string,
): Promise<Array<{ instance: string | null; unit: string | null; value: string | null }>> {
  return db
    .select({
      instance: stationConfigurations.instance,
      unit: stationConfigurations.unit,
      value: stationConfigurations.value,
    })
    .from(stationConfigurations)
    .where(
      and(
        eq(stationConfigurations.stationId, stationUuid),
        eq(stationConfigurations.component, LOW_SIGNAL_COMPONENT),
        eq(stationConfigurations.variable, LOW_SIGNAL_VARIABLE),
        eq(stationConfigurations.attributeType, 'Actual'),
        eq(stationConfigurations.supportsMonitoring, true),
        inOperatorStation(stationConfigurations.stationId),
      ),
    );
}

async function storedMonitors(stationUuid: string): Promise<MonitorRuleRow[]> {
  return db
    .select()
    .from(variableMonitoringRules)
    .where(
      and(
        eq(variableMonitoringRules.stationId, stationUuid),
        eq(variableMonitoringRules.source, LOW_SIGNAL_SOURCE),
      ),
    );
}

async function publish(
  station: Pick<SignalMonitorStation, 'stationId'>,
  action: 'SetVariableMonitoring' | 'ClearVariableMonitoring' | 'GetMonitoringReport',
  payload: Record<string, unknown>,
  deps: SignalMonitorDeps,
): Promise<void> {
  try {
    // Never queued: a monitor command means nothing to a station that reconnects
    // later, which gets its monitors again after its boot.
    await publishOcppCommand(deps.pubsub, {
      stationId: station.stationId,
      action,
      payload,
      noQueue: true,
    });
  } catch (err: unknown) {
    deps.log.warn(
      { err, stationId: station.stationId, action },
      'Low signal monitor command not published; the next settings save or boot sends it again',
    );
  }
}

/**
 * Removes the station's monitors. A pending row (a send or a read the station
 * has not answered) stays until its answer, which removes it then; after a boot
 * no answer comes, so it is removed like the others. An online station gets
 * ClearVariableMonitoring for the known ids and the rows are deleted; a pending
 * row without a known id may still have a monitor on the station, so an online
 * 2.x station reads it back first (`remove`) and the read clears what it finds.
 * An offline station's rows are marked `cleared`, and its next boot clears them.
 */
async function removeMonitors(
  station: SignalMonitorStation,
  rows: readonly MonitorRuleRow[],
  deps: SignalMonitorDeps,
  afterBoot: boolean,
): Promise<number> {
  const settled = afterBoot ? rows : rows.filter((row) => row.status !== 'pending');
  if (settled.length === 0) return 0;
  const rowIds = settled.map((row) => row.id);
  if (!station.isOnline) {
    await db
      .update(variableMonitoringRules)
      .set({ status: 'cleared', updatedAt: new Date() })
      .where(inArray(variableMonitoringRules.id, rowIds));
    return settled.length;
  }
  const unknown = isOcpp2x(station.ocppProtocol)
    ? settled.filter((row) => row.status === 'pending' && row.monitoringId == null)
    : [];
  const known = settled.filter((row) => !unknown.includes(row));
  const ids = known.flatMap((row) => (row.monitoringId != null ? [row.monitoringId] : []));
  if (known.length > 0) {
    await db.delete(variableMonitoringRules).where(
      inArray(
        variableMonitoringRules.id,
        known.map((row) => row.id),
      ),
    );
  }
  if (ids.length > 0) {
    await publish(station, 'ClearVariableMonitoring', { id: ids }, deps);
  }
  await readLowSignalMonitorIds(station, unknown, REMOVE, deps);
  return settled.length;
}

/** Whether a read the station accepted has waited longer than its report may take. */
export function lowSignalReadExpired(row: MonitorRuleRow, now: Date): boolean {
  return (
    row.status === 'pending' &&
    row.reportRequestId != null &&
    now.getTime() - row.updatedAt.getTime() > LOW_SIGNAL_READ_TTL_MS
  );
}

/**
 * Ends the reads whose report never came: they become `error`, keeping a known
 * id, so the sync treats them as settled (removed with the alert off). Returns
 * the rows as they are now.
 */
async function settleExpiredReads(
  rows: readonly MonitorRuleRow[],
  now: Date,
): Promise<MonitorRuleRow[]> {
  const expired = rows.filter((row) => lowSignalReadExpired(row, now));
  if (expired.length === 0) return [...rows];
  const ended = await db
    .update(variableMonitoringRules)
    .set({
      status: 'error',
      reportRequestId: null,
      reportReason: null,
      errorInfo: READ_EXPIRED,
      updatedAt: now,
    })
    .where(
      and(
        inArray(
          variableMonitoringRules.id,
          expired.map((row) => row.id),
        ),
        eq(variableMonitoringRules.status, 'pending'),
        isNotNull(variableMonitoringRules.reportRequestId),
      ),
    )
    .returning();
  const byId = new Map(ended.map((row) => [row.id, row]));
  return rows.map((row) => byId.get(row.id) ?? row);
}

export interface LowSignalTarget {
  instance: string | null;
  /** The monitor value in the station's unit. */
  threshold: number;
}

/** What one sync does: rows sent again or replaced, new rows, rows to clear. */
export interface LowSignalSyncPlan {
  /** Existing rows set pending with `value`, sent with `replaceId` or without an id. */
  resend: Array<{ row: MonitorRuleRow; value: number; replaceId: number | null }>;
  insert: LowSignalTarget[];
  remove: MonitorRuleRow[];
}

/**
 * The decision of `syncStationLowSignalMonitor` for an online 2.x station that
 * wants the monitors. Per modem: a pending monitor (a send or read in flight)
 * waits for its answer, which syncs again when the threshold changed meanwhile;
 * an unchanged active monitor is left alone; after a boot a pending monitor is
 * no longer in flight and an unchanged active monitor is sent again without its id
 * (the station keeps custom monitors across a reboot, N07.FR.13, and answers
 * Duplicate, N04.FR.10); any other monitor the station has an id for is
 * replaced by that id (N04.FR.12), a threshold changed while the station was
 * offline included; one without an id is sent again without one. Rows of
 * modems no longer monitorable are removed.
 */
export function planLowSignalSync(
  rows: readonly MonitorRuleRow[],
  targets: readonly LowSignalTarget[],
  afterBoot: boolean,
  options: { changedValuesOnly?: boolean } = {},
): LowSignalSyncPlan {
  const plan: LowSignalSyncPlan = { resend: [], insert: [], remove: [] };
  const kept = new Set<number>();
  for (const target of targets) {
    const row = rows.find(
      (r) => (r.componentInstance ?? null) === (target.instance ?? null) && !kept.has(r.id),
    );
    if (row == null) {
      plan.insert.push(target);
      continue;
    }
    kept.add(row.id);
    if (row.status === 'pending' && !afterBoot) continue;
    const sameValue = Number(row.value) === target.threshold;
    if (sameValue && options.changedValuesOnly === true) continue;
    if (sameValue && row.status === 'active' && !afterBoot) continue;
    if (sameValue && afterBoot && row.status === 'active' && row.monitoringId != null) {
      plan.resend.push({ row, value: target.threshold, replaceId: null });
      continue;
    }
    plan.resend.push({ row, value: target.threshold, replaceId: row.monitoringId });
  }
  plan.remove = rows.filter((r) => !kept.has(r.id));
  return plan;
}

type MonitorItemFields = Pick<
  MonitorRuleRow,
  'component' | 'componentInstance' | 'variable' | 'type' | 'value' | 'severity'
>;

/** Inserts a pending low signal row; null when a concurrent sync stored one for the modem. */
async function insertLowSignalRow(
  stationUuid: string,
  target: LowSignalTarget,
): Promise<MonitorItemFields | null> {
  const inserted = await db.execute(sql`
    INSERT INTO variable_monitoring_rules
      (station_id, component, component_instance, variable, type, value, severity, source, status)
    VALUES (${stationUuid}, ${LOW_SIGNAL_COMPONENT}, ${target.instance}, ${LOW_SIGNAL_VARIABLE},
      ${LOW_SIGNAL_TYPE}, ${String(target.threshold)}, ${LOW_SIGNAL_SEVERITY},
      ${LOW_SIGNAL_SOURCE}, 'pending')
    ON CONFLICT (station_id, (COALESCE(component_instance, ''))) WHERE source = 'low_signal'
    DO NOTHING
    RETURNING id`);
  if (inserted.length === 0) return null;
  return {
    component: LOW_SIGNAL_COMPONENT,
    componentInstance: target.instance,
    variable: LOW_SIGNAL_VARIABLE,
    type: LOW_SIGNAL_TYPE,
    value: String(target.threshold),
    severity: LOW_SIGNAL_SEVERITY,
  };
}

/**
 * Brings one station's low signal monitors in line with the settings. Online
 * OCPP 2.0.1 and 2.1 stations get a monitor on each DataLink.SignalStrength their
 * NotifyReport marked monitorable (N04.FR.05); `planLowSignalSync` decides when
 * a monitor is replaced or sent again. Switched off or cleared, the monitors are
 * cleared (online) and their rows deleted. An offline station keeps its rows and
 * gets its monitors after its boot.
 */
export async function syncStationLowSignalMonitor(
  station: SignalMonitorStation,
  settings: SignalSettings,
  deps: SignalMonitorDeps,
  options: { afterBoot?: boolean; changedValuesOnly?: boolean; now?: Date } = {},
): Promise<SignalMonitorSyncResult> {
  const rows = await settleExpiredReads(
    await storedMonitors(station.id),
    options.now ?? new Date(),
  );
  const afterBoot = options.afterBoot === true;
  if (!lowSignalWanted(settings) || !isOcpp2x(station.ocppProtocol)) {
    return { set: 0, cleared: await removeMonitors(station, rows, deps, afterBoot) };
  }
  if (!station.isOnline) return { set: 0, cleared: 0 };

  const targets = (await monitorableSignals(station.id)).flatMap((signal) => {
    const threshold = lowSignalThreshold(settings.signalAlertBelowDbm, signal);
    return threshold == null ? [] : [{ instance: signal.instance, threshold }];
  });
  const plan = planLowSignalSync(rows, targets, afterBoot, {
    ...(options.changedValuesOnly === true ? { changedValuesOnly: true } : {}),
  });
  const items: Array<Record<string, unknown>> = [];
  for (const { row, value, replaceId } of plan.resend) {
    const [updated] = await db
      .update(variableMonitoringRules)
      .set({
        value: String(value),
        status: 'pending',
        errorInfo: null,
        reportRequestId: null,
        reportReason: null,
        updatedAt: new Date(),
      })
      .where(eq(variableMonitoringRules.id, row.id))
      .returning();
    if (updated != null) items.push(setMonitoringDataItem(updated, replaceId ?? undefined));
  }
  for (const target of plan.insert) {
    const rule = await insertLowSignalRow(station.id, target);
    if (rule != null) items.push(setMonitoringDataItem(rule));
  }
  const cleared = await removeMonitors(station, plan.remove, deps, afterBoot);
  if (items.length > 0) {
    await publish(station, 'SetVariableMonitoring', { setMonitoringData: items }, deps);
  }
  return { set: items.length, cleared };
}

/** Stations a settings-save sync reads at a time. */
export const LOW_SIGNAL_SYNC_BATCH = 100;

/**
 * After a settings save: every station that holds a low signal monitor, and
 * every online station whose report shows a monitorable signal, read in batches
 * of `batchSize` by station id. With station signal reads off and no monitor
 * stored this reads two indexes and sends nothing.
 */
export async function syncLowSignalMonitors(
  settings: SignalSettings,
  deps: SignalMonitorDeps,
  options: { batchSize?: number } = {},
): Promise<SignalMonitorSyncResult> {
  const batchSize = options.batchSize ?? LOW_SIGNAL_SYNC_BATCH;
  const holding = db
    .select({ id: variableMonitoringRules.stationId })
    .from(variableMonitoringRules)
    .where(eq(variableMonitoringRules.source, LOW_SIGNAL_SOURCE));
  const conditions = [inArray(chargingStations.id, holding)];
  if (lowSignalWanted(settings)) {
    // Conformance test stations are only cleared (they never get a monitor).
    const monitorable = db
      .select({ id: stationConfigurations.stationId })
      .from(stationConfigurations)
      .where(
        and(
          eq(stationConfigurations.component, LOW_SIGNAL_COMPONENT),
          eq(stationConfigurations.variable, LOW_SIGNAL_VARIABLE),
          eq(stationConfigurations.supportsMonitoring, true),
        ),
      );
    const online = and(
      eq(chargingStations.isOnline, true),
      isOperatorStation(),
      inArray(chargingStations.id, monitorable),
    );
    if (online != null) conditions.push(online);
  }
  const total: SignalMonitorSyncResult = { set: 0, cleared: 0 };
  let after: string | null = null;
  for (;;) {
    const stations: SignalMonitorStation[] = await db
      .select({
        id: chargingStations.id,
        stationId: chargingStations.stationId,
        ocppProtocol: chargingStations.ocppProtocol,
        isOnline: chargingStations.isOnline,
      })
      .from(chargingStations)
      .where(and(or(...conditions), after != null ? gt(chargingStations.id, after) : undefined))
      .orderBy(asc(chargingStations.id))
      .limit(batchSize);
    for (const station of stations) {
      try {
        const result = await syncStationLowSignalMonitor(station, settings, deps);
        total.set += result.set;
        total.cleared += result.cleared;
      } catch (err: unknown) {
        deps.log.warn(
          { err, stationId: station.stationId },
          'Low signal monitor sync failed for a station; the others go on',
        );
      }
    }
    const last = stations.at(-1);
    if (last == null || stations.length < batchSize) return total;
    after = last.id;
  }
}

let running: Promise<void> | null = null;
let rerun = false;

/** Takes the request for one more run, made by a save during the current run. */
function takeRerun(): boolean {
  const asked = rerun;
  rerun = false;
  return asked;
}

/**
 * Runs `syncLowSignalMonitors` outside the caller, so a settings save answers
 * at once. One run per process at a time: a save during a run asks for one more
 * run, which reads the settings again. Failures are logged; the next save or a
 * station boot syncs again. Returns the run, for tests.
 */
export function scheduleLowSignalSync(
  readSettings: () => Promise<SignalSettings>,
  deps: SignalMonitorDeps,
  sync: typeof syncLowSignalMonitors = syncLowSignalMonitors,
): Promise<void> {
  if (running != null) {
    rerun = true;
    return running;
  }
  const run = async (): Promise<void> => {
    for (;;) {
      try {
        const result = await sync(await readSettings(), deps);
        deps.log.info(result, 'Low signal monitors synced after the settings save');
      } catch (err: unknown) {
        deps.log.warn(
          { err },
          'Low signal monitors not synced after the settings save; the next save or boot does it',
        );
      }
      // Cleared in the same step that finds no request, so no save falls in between.
      if (!takeRerun()) {
        running = null;
        return;
      }
    }
  };
  running = run();
  return running;
}

interface MonitorItem {
  id?: unknown;
  component?: { name?: unknown; instance?: unknown };
  variable?: { name?: unknown };
  type?: unknown;
  severity?: unknown;
  value?: unknown;
  status?: unknown;
}

/** The items of a SetVariableMonitoring request shaped like a low signal monitor. */
function lowSignalItems(request: Record<string, unknown> | undefined): MonitorItem[] {
  const data = request?.setMonitoringData;
  if (!Array.isArray(data)) return [];
  return (data as MonitorItem[]).filter(
    (item) =>
      item.component?.name === LOW_SIGNAL_COMPONENT &&
      item.variable?.name === LOW_SIGNAL_VARIABLE &&
      item.type === LOW_SIGNAL_TYPE &&
      item.severity === LOW_SIGNAL_SEVERITY,
  );
}

function instanceOf(item: MonitorItem): string | null {
  return typeof item.component?.instance === 'string' ? item.component.instance : null;
}

/** The station's result for a request item: same component, variable, type and severity. */
function resultFor(
  item: MonitorItem,
  results: readonly MonitorItem[],
  used: Set<number>,
): MonitorItem | null {
  const index = results.findIndex(
    (r, i) =>
      !used.has(i) &&
      r.component?.name === item.component?.name &&
      instanceOf(r) === instanceOf(item) &&
      r.variable?.name === item.variable?.name &&
      r.type === item.type &&
      r.severity === item.severity,
  );
  if (index < 0) return null;
  used.add(index);
  return results[index] ?? null;
}

/** The pending low signal row a request item was sent for: its modem, value and id. */
async function pendingRowFor(
  stationUuid: string,
  item: MonitorItem,
): Promise<MonitorRuleRow | null> {
  const rows = await db
    .select()
    .from(variableMonitoringRules)
    .where(
      and(
        eq(variableMonitoringRules.stationId, stationUuid),
        eq(variableMonitoringRules.source, LOW_SIGNAL_SOURCE),
        eq(variableMonitoringRules.status, 'pending'),
        isNull(variableMonitoringRules.reportRequestId),
      ),
    );
  const instance = instanceOf(item);
  return (
    rows.find(
      (row) =>
        (row.componentInstance ?? null) === instance &&
        Number(row.value) === item.value &&
        (item.id == null || row.monitoringId === item.id),
    ) ?? null
  );
}

export type LowSignalResultOutcome =
  | {
      kind: 'store';
      status: 'active' | 'error';
      monitoringId: number | null;
      errorInfo: string | null;
    }
  | { kind: 'resend' }
  | { kind: 'read' };

/**
 * The stored state for the station's answer to one low signal item. A replace
 * (the item carried an id) answered Rejected means the station has no monitor
 * with that id (N04.FR.13): the monitor is sent again without one. Duplicate is
 * active only for a monitor sent again unchanged after a boot (no id sent, the
 * id known). Without a known id the station holds a monitor of this type and
 * severity whose id the CSMS lacks (N04.FR.10): it is read back with
 * GetMonitoringReport. A replace answered Duplicate is an error.
 * Any other refusal keeps the known id, so the next sync replaces by it.
 */
export function lowSignalResultOutcome(
  sentId: number | null,
  knownId: number | null,
  result: Record<string, unknown> | null,
): LowSignalResultOutcome {
  if (sentId != null && result?.status === 'Rejected') return { kind: 'resend' };
  if (result?.status === 'Duplicate') {
    if (sentId == null && knownId != null) {
      return { kind: 'store', status: 'active', monitoringId: knownId, errorInfo: null };
    }
    if (sentId == null) return { kind: 'read' };
    return {
      kind: 'store',
      status: 'error',
      monitoringId: knownId,
      errorInfo:
        'Duplicate: the station holds a monitor of this type and severity under another id',
    };
  }
  const outcome = monitorResultOutcome(result);
  return {
    kind: 'store',
    status: outcome.status,
    monitoringId: outcome.status === 'active' ? outcome.monitoringId : knownId,
    errorInfo: outcome.errorInfo,
  };
}

/** The station and settings an answer is followed up with. */
async function stationForFollowUp(stationUuid: string): Promise<SignalMonitorStation | null> {
  const [row] = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
      isOnline: chargingStations.isOnline,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationUuid));
  return row ?? null;
}

/**
 * After the station answered: a monitor no longer wanted (switched off while
 * the send was in flight) is cleared and its row deleted, and a monitor whose
 * threshold changed while it was in flight is replaced by its id. Unchanged
 * monitors are left alone, so a refusal is never sent again in a loop.
 */
async function followUpLowSignal(stationUuid: string, deps: SignalMonitorDeps): Promise<void> {
  const station = await stationForFollowUp(stationUuid);
  if (station == null) return;
  const settings = await getSimGeneralSettings();
  await syncStationLowSignalMonitor(station, settings, deps, { changedValuesOnly: true });
}

/** Whether the alert still wants monitors on this station's protocol. */
async function lowSignalStillWanted(stationUuid: string): Promise<boolean> {
  const station = await stationForFollowUp(stationUuid);
  return (
    station != null &&
    isOcpp2x(station.ocppProtocol) &&
    lowSignalWanted(await getSimGeneralSettings())
  );
}

/**
 * Why a low signal monitor id is read back. `timeout`: a send got no answer, so
 * the station may hold the monitor; a read that finds none sends it again, once.
 * `duplicate`: the station answered Duplicate; a read that finds none ends in
 * `error`. `resent`: the read of the one send after a timeout read; it never
 * sends again. `remove`: a monitor no longer wanted whose id is unknown after a
 * boot; what the read finds is cleared, and the row is deleted in every case.
 */
export type LowSignalReadReason = 'timeout' | 'duplicate' | 'resent' | 'remove';

/** The `report_reason` of the one send after a timeout read found no monitor. */
const RESENT = 'resent';
/** The `report_reason` of a read that finds a monitor to clear. */
const REMOVE = 'remove';

/**
 * Reads the station's low signal monitors back with GetMonitoringReport
 * (component DataLink and its instance, variable SignalStrength, criteria
 * ThresholdMonitoring; N02), after a send that got no answer or a Duplicate
 * for a monitor whose id the CSMS lacks. The rows stay pending with the
 * request id and the reason until the report or the answer to the request arrives.
 */
export async function readLowSignalMonitorIds(
  station: Pick<SignalMonitorStation, 'id' | 'stationId'>,
  rows: readonly MonitorRuleRow[],
  reason: LowSignalReadReason,
  deps: SignalMonitorDeps,
): Promise<number> {
  if (rows.length === 0) return 0;
  const requestId = randomInt(1, 2_147_483_647);
  const marked = await db
    .update(variableMonitoringRules)
    .set({
      status: 'pending',
      reportRequestId: requestId,
      reportReason: reason,
      errorInfo: null,
      updatedAt: new Date(),
    })
    .where(
      inArray(
        variableMonitoringRules.id,
        rows.map((row) => row.id),
      ),
    )
    .returning();
  if (marked.length === 0) return 0;
  await publish(
    station,
    'GetMonitoringReport',
    {
      requestId,
      monitoringCriteria: ['ThresholdMonitoring'],
      componentVariable: marked.map((row) => ({
        component: {
          name: LOW_SIGNAL_COMPONENT,
          ...(row.componentInstance != null ? { instance: row.componentInstance } : {}),
        },
        variable: { name: LOW_SIGNAL_VARIABLE },
      })),
    },
    deps,
  );
  return marked.length;
}

/**
 * Sends monitors again without an id after a timeout read found none, marked
 * `resent` so the read of this send never sends them again.
 */
async function resendWithoutId(
  station: Pick<SignalMonitorStation, 'id' | 'stationId'>,
  rows: readonly MonitorRuleRow[],
  deps: SignalMonitorDeps,
): Promise<void> {
  const items: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const [cleared] = await db
      .update(variableMonitoringRules)
      .set({
        status: 'pending',
        monitoringId: null,
        reportRequestId: null,
        reportReason: RESENT,
        errorInfo: null,
        updatedAt: new Date(),
      })
      .where(eq(variableMonitoringRules.id, row.id))
      .returning();
    if (cleared != null) items.push(setMonitoringDataItem(cleared));
  }
  if (items.length > 0) {
    await publish(station, 'SetVariableMonitoring', { setMonitoringData: items }, deps);
  }
}

/**
 * Records the station's answer to a SetVariableMonitoring on the pending low
 * signal rows the request named: the row of the item's modem whose value (and
 * id, for a replace) the item sent, so an operator rule's answer or a late
 * answer for an earlier threshold changes nothing. A replace the station no
 * longer knows is sent again without an id; a Duplicate for a monitor without
 * a known id is read back. Then the station is followed up: switched off
 * meanwhile, the monitor is cleared; a threshold changed meanwhile, replaced.
 */
export async function recordLowSignalMonitorResults(
  station: { id: string; stationId: string },
  request: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
  deps: SignalMonitorDeps,
): Promise<number> {
  const items = lowSignalItems(request);
  const results = Array.isArray(response?.setMonitoringResult)
    ? (response.setMonitoringResult as MonitorItem[])
    : [];
  const used = new Set<number>();
  const resend: MonitorRuleRow[] = [];
  const read: MonitorRuleRow[] = [];
  let updated = 0;
  for (const item of items) {
    const result = resultFor(item, results, used);
    const row = await pendingRowFor(station.id, item);
    if (row == null) continue;
    const sentId = typeof item.id === 'number' ? item.id : null;
    const outcome = lowSignalResultOutcome(
      sentId,
      row.monitoringId,
      result as Record<string, unknown> | null,
    );
    const pendingRow = and(
      eq(variableMonitoringRules.id, row.id),
      eq(variableMonitoringRules.status, 'pending'),
    );
    if (outcome.kind === 'read') {
      read.push(row);
      updated += 1;
      continue;
    }
    if (outcome.kind === 'resend') {
      const [cleared] = await db
        .update(variableMonitoringRules)
        .set({ monitoringId: null, updatedAt: new Date() })
        .where(pendingRow)
        .returning();
      if (cleared != null) {
        resend.push(cleared);
        updated += 1;
      }
      continue;
    }
    const changed = await db
      .update(variableMonitoringRules)
      .set({
        status: outcome.status,
        monitoringId: outcome.monitoringId,
        errorInfo: outcome.errorInfo,
        reportReason: null,
        updatedAt: new Date(),
      })
      .where(pendingRow)
      .returning({ id: variableMonitoringRules.id });
    updated += changed.length;
  }
  // The one send after a timeout read never sends again, whatever it was answered.
  await readLowSignalMonitorIds(
    station,
    read.filter((row) => row.reportReason !== RESENT),
    'duplicate',
    deps,
  );
  await readLowSignalMonitorIds(
    station,
    read.filter((row) => row.reportReason === RESENT),
    'resent',
    deps,
  );
  if (resend.length > 0) {
    if (await lowSignalStillWanted(station.id)) {
      await publish(
        station,
        'SetVariableMonitoring',
        { setMonitoringData: resend.map((row) => setMonitoringDataItem(row)) },
        deps,
      );
    } else {
      // The replaced monitor is gone from the station and none is wanted any more.
      await db.delete(variableMonitoringRules).where(
        inArray(
          variableMonitoringRules.id,
          resend.map((row) => row.id),
        ),
      );
    }
  }
  if (updated > 0) await followUpLowSignal(station.id, deps);
  return updated;
}

/**
 * A SetVariableMonitoring that got no answer. On a timeout the station may
 * have set the monitor, so its id is read back with GetMonitoringReport. Any
 * other failure (a CALLERROR, a station that was not connected) marks the
 * pending rows `error`, keeping their known id, so the next save or boot sends
 * them again; a monitor no longer wanted is then removed.
 */
export async function recordLowSignalMonitorFailure(
  station: { id: string; stationId: string },
  request: Record<string, unknown> | undefined,
  error: string,
  deps: SignalMonitorDeps,
  options: { timedOut?: boolean } = {},
): Promise<number> {
  const rows: MonitorRuleRow[] = [];
  for (const item of lowSignalItems(request)) {
    const row = await pendingRowFor(station.id, item);
    if (row != null) rows.push(row);
  }
  if (rows.length === 0) return 0;
  if (options.timedOut === true) {
    const resent = rows.filter((row) => row.reportReason === RESENT);
    const first = rows.filter((row) => row.reportReason !== RESENT);
    return (
      (await readLowSignalMonitorIds(station, first, 'timeout', deps)) +
      (await readLowSignalMonitorIds(station, resent, 'resent', deps))
    );
  }
  const changed = await db
    .update(variableMonitoringRules)
    .set({ status: 'error', errorInfo: error, reportReason: null, updatedAt: new Date() })
    .where(
      and(
        inArray(
          variableMonitoringRules.id,
          rows.map((row) => row.id),
        ),
        eq(variableMonitoringRules.status, 'pending'),
      ),
    )
    .returning({ id: variableMonitoringRules.id });
  if (changed.length > 0) await followUpLowSignal(station.id, deps);
  return changed.length;
}

/** The low signal rows waiting for the GetMonitoringReport with this request id. */
async function readingRows(stationUuid: string, requestId: unknown): Promise<MonitorRuleRow[]> {
  if (typeof requestId !== 'number') return [];
  return db
    .select()
    .from(variableMonitoringRules)
    .where(
      and(
        eq(variableMonitoringRules.stationId, stationUuid),
        eq(variableMonitoringRules.source, LOW_SIGNAL_SOURCE),
        eq(variableMonitoringRules.status, 'pending'),
        eq(variableMonitoringRules.reportRequestId, requestId),
      ),
    );
}

/**
 * Deletes the rows of a removal read that is over, still the rows of this read.
 * Returns the deleted ids, so only the read that deletes a row clears its monitor.
 */
async function deleteRemovalRows(rows: readonly MonitorRuleRow[]): Promise<Set<number>> {
  if (rows.length === 0) return new Set();
  const deleted = await db
    .delete(variableMonitoringRules)
    .where(
      and(
        inArray(
          variableMonitoringRules.id,
          rows.map((row) => row.id),
        ),
        eq(variableMonitoringRules.status, 'pending'),
        eq(variableMonitoringRules.reportReason, REMOVE),
      ),
    )
    .returning({ id: variableMonitoringRules.id });
  return new Set(deleted.map((row) => row.id));
}

const READ_FOUND_NONE: Record<Exclude<LowSignalReadReason, 'timeout' | 'remove'>, string> = {
  duplicate:
    'Duplicate: the station holds a monitor of this type and severity, and its report lists none',
  resent: 'GetMonitoringReport: no monitor after the monitor was sent again',
};

/** Marks pending read rows `error`, ending the read. */
async function failRead(rows: readonly MonitorRuleRow[], errorInfo: string): Promise<number> {
  if (rows.length === 0) return 0;
  const changed = await db
    .update(variableMonitoringRules)
    .set({
      status: 'error',
      reportRequestId: null,
      reportReason: null,
      errorInfo,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(
          variableMonitoringRules.id,
          rows.map((row) => row.id),
        ),
        eq(variableMonitoringRules.status, 'pending'),
      ),
    )
    .returning({ id: variableMonitoringRules.id });
  return changed.length;
}

/**
 * Ends a read that found no monitor. Removed when no longer wanted. Otherwise a
 * read started by a timeout sends the monitor again without an id, once; a read
 * started by a Duplicate, or the read of that one send, ends in `error`, so a
 * station that keeps answering Duplicate never loops. Returns the rows marked `error`.
 */
async function endReadWithoutMonitor(
  station: { id: string; stationId: string },
  read: readonly MonitorRuleRow[],
  deps: SignalMonitorDeps,
): Promise<number> {
  await deleteRemovalRows(read.filter((row) => row.reportReason === REMOVE));
  const rows = read.filter((row) => row.reportReason !== REMOVE);
  if (rows.length === 0) return 0;
  if (!(await lowSignalStillWanted(station.id))) {
    await db.delete(variableMonitoringRules).where(
      inArray(
        variableMonitoringRules.id,
        rows.map((row) => row.id),
      ),
    );
    return 0;
  }
  await resendWithoutId(
    station,
    rows.filter((row) => row.reportReason === 'timeout'),
    deps,
  );
  let failed = 0;
  for (const reason of ['duplicate', 'resent'] as const) {
    failed += await failRead(
      rows.filter((row) => (row.reportReason ?? 'duplicate') === reason),
      READ_FOUND_NONE[reason],
    );
  }
  return failed;
}

/**
 * The station's answer to the GetMonitoringReport of a low signal read.
 * Accepted waits for NotifyMonitoringReport. EmptyResultSet means the station
 * holds no such monitor (N02.FR.06): it is sent again without an id. Any other
 * answer, or none, marks the rows `error`; the next save or boot sends them again.
 */
export async function recordLowSignalReportResult(
  station: { id: string; stationId: string },
  request: Record<string, unknown> | undefined,
  outcome: { response?: Record<string, unknown> | undefined; error?: string },
  deps: SignalMonitorDeps,
): Promise<number> {
  const all = await readingRows(station.id, request?.requestId);
  if (all.length === 0) return 0;
  const status = outcome.response?.status;
  if (outcome.error == null && status === 'Accepted') return 0;
  if (outcome.error == null && status === 'EmptyResultSet') {
    const failed = await endReadWithoutMonitor(station, all, deps);
    if (failed > 0) await followUpLowSignal(station.id, deps);
    return all.length;
  }
  const reason =
    outcome.error ?? (typeof status === 'string' ? status : 'No GetMonitoringReport status');
  const removed = await deleteRemovalRows(all.filter((row) => row.reportReason === REMOVE));
  if (removed.size > 0) {
    deps.log.warn(
      { stationId: station.stationId, reason },
      'Low signal monitor removal read failed; the row is deleted, a monitor may stay on the station',
    );
  }
  const rows = all.filter((row) => row.reportReason !== REMOVE);
  if (rows.length === 0) return removed.size;
  const changed = await db
    .update(variableMonitoringRules)
    .set({
      status: 'error',
      reportRequestId: null,
      reportReason: null,
      errorInfo: `GetMonitoringReport: ${reason}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(
          variableMonitoringRules.id,
          rows.map((row) => row.id),
        ),
        eq(variableMonitoringRules.status, 'pending'),
      ),
    )
    .returning({ id: variableMonitoringRules.id });
  if (changed.length > 0) await followUpLowSignal(station.id, deps);
  return changed.length + removed.size;
}

interface ReportedMonitoring {
  component?: { name?: unknown; instance?: unknown };
  variable?: { name?: unknown };
  variableMonitoring?: Array<{ id?: unknown; value?: unknown; type?: unknown; severity?: unknown }>;
}

export type ReportedLowSignal =
  | { kind: 'found'; id: number; value: number }
  /** Only a monitor an operator rule of the station holds matches. */
  | { kind: 'operator' }
  | { kind: 'none' };

/**
 * The low signal monitor a NotifyMonitoringReport lists for a modem. A monitor
 * whose id an operator rule of the station holds is never taken over.
 */
export function reportedLowSignalMonitor(
  monitors: readonly ReportedMonitoring[],
  instance: string | null,
  operatorIds: ReadonlySet<number>,
): ReportedLowSignal {
  let operatorOnly = false;
  for (const entry of monitors) {
    if (entry.component?.name !== LOW_SIGNAL_COMPONENT) continue;
    if (entry.variable?.name !== LOW_SIGNAL_VARIABLE) continue;
    const entryInstance =
      typeof entry.component.instance === 'string' ? entry.component.instance : null;
    if (entryInstance !== instance) continue;
    for (const monitor of entry.variableMonitoring ?? []) {
      if (
        monitor.type === LOW_SIGNAL_TYPE &&
        monitor.severity === LOW_SIGNAL_SEVERITY &&
        typeof monitor.id === 'number' &&
        Number.isInteger(monitor.id) &&
        typeof monitor.value === 'number'
      ) {
        if (operatorIds.has(monitor.id)) {
          operatorOnly = true;
          continue;
        }
        return { kind: 'found', id: monitor.id, value: monitor.value };
      }
    }
  }
  return operatorOnly ? { kind: 'operator' } : { kind: 'none' };
}

/** The monitor ids the station's operator rules hold. */
async function operatorMonitorIds(stationUuid: string): Promise<Set<number>> {
  const rows = await db
    .select({ monitoringId: variableMonitoringRules.monitoringId })
    .from(variableMonitoringRules)
    .where(
      and(
        eq(variableMonitoringRules.stationId, stationUuid),
        ne(variableMonitoringRules.source, LOW_SIGNAL_SOURCE),
        isNotNull(variableMonitoringRules.monitoringId),
      ),
    );
  return new Set(rows.flatMap((row) => (row.monitoringId != null ? [row.monitoringId] : [])));
}

const OPERATOR_MONITOR_ONLY =
  "GetMonitoringReport: the station's only monitor of this type and severity belongs to an operator rule";

/**
 * A NotifyMonitoringReport of a low signal read: each modem's LowerThreshold
 * monitor of severity 6 becomes `active` with the station's id and value, and
 * a value that differs from the threshold is then replaced by that id. A
 * monitor an operator rule holds is never taken over: a modem whose only match
 * is one ends in `error`. A modem the last message of the report (tbc false)
 * does not list holds no such monitor (`endReadWithoutMonitor`).
 */
export async function recordLowSignalMonitorReport(
  station: { id: string; stationId: string },
  report: Record<string, unknown>,
  deps: SignalMonitorDeps,
): Promise<number> {
  const all = await readingRows(station.id, report.requestId);
  if (all.length === 0) return 0;
  const monitors = Array.isArray(report.monitor) ? (report.monitor as ReportedMonitoring[]) : [];
  const operatorIds = await operatorMonitorIds(station.id);
  // A later message of the report may still list the modem's own monitor.
  const last = report.tbc !== true;
  const removed = await endRemovalReads(
    station,
    all.filter((row) => row.reportReason === REMOVE),
    { monitors, operatorIds, last },
    deps,
  );
  const rows = all.filter((row) => row.reportReason !== REMOVE);
  if (rows.length === 0) return removed;
  const missing: MonitorRuleRow[] = [];
  const operatorOnly: MonitorRuleRow[] = [];
  let found = 0;
  for (const row of rows) {
    const reported = reportedLowSignalMonitor(monitors, row.componentInstance ?? null, operatorIds);
    if (reported.kind === 'none') {
      missing.push(row);
      continue;
    }
    if (reported.kind === 'operator') {
      operatorOnly.push(row);
      continue;
    }
    const changed = await db
      .update(variableMonitoringRules)
      .set({
        status: 'active',
        monitoringId: reported.id,
        value: String(reported.value),
        reportRequestId: null,
        reportReason: null,
        errorInfo: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(variableMonitoringRules.id, row.id), eq(variableMonitoringRules.status, 'pending')),
      )
      .returning({ id: variableMonitoringRules.id });
    found += changed.length;
  }
  const failed = last
    ? (await failRead(operatorOnly, OPERATOR_MONITOR_ONLY)) +
      (await endReadWithoutMonitor(station, missing, deps))
    : 0;
  if (found > 0 || failed > 0) await followUpLowSignal(station.id, deps);
  return removed + found + (last ? missing.length + operatorOnly.length : 0);
}

/**
 * The removal reads a report answers: a monitor it lists for the modem is
 * cleared by the station's id (never one an operator rule holds) and the row
 * deleted; a modem the last message does not list holds none, so its row is
 * deleted. Returns the rows ended.
 */
async function endRemovalReads(
  station: { id: string; stationId: string },
  rows: readonly MonitorRuleRow[],
  report: {
    monitors: readonly ReportedMonitoring[];
    operatorIds: ReadonlySet<number>;
    last: boolean;
  },
  deps: SignalMonitorDeps,
): Promise<number> {
  const ended: MonitorRuleRow[] = [];
  const clearIds = new Map<number, number>();
  for (const row of rows) {
    const reported = reportedLowSignalMonitor(
      report.monitors,
      row.componentInstance ?? null,
      report.operatorIds,
    );
    if (reported.kind === 'found') clearIds.set(row.id, reported.id);
    if (reported.kind !== 'none' || report.last) ended.push(row);
  }
  const deleted = await deleteRemovalRows(ended);
  const ids = [...clearIds].flatMap(([rowId, id]) => (deleted.has(rowId) ? [id] : []));
  if (ids.length > 0) await publish(station, 'ClearVariableMonitoring', { id: ids }, deps);
  return deleted.size;
}
