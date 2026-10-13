// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import {
  AI_INSIGHT_SETTING_KEYS,
  INSIGHT_KIND_FALLBACKS,
  RULE_INSIGHTS,
} from '@evtivity/lib/ai-insights';
import type {
  FixCode,
  InsightConfidence,
  InsightKind,
  InsightScope,
  InsightVisibleStatus,
  RootCauseCategory,
} from '@evtivity/lib/ai-insights';
import { AI_WORKER_ACTIONS } from '@evtivity/lib/ai-proposals';
import type { AiWorkerAction, AiWorkerActionKind, AiWorkerJob } from '@evtivity/lib/ai-proposals';
import { formatUnitPrice } from '@evtivity/lib/currency';
import { aiArgsHash, authorizationSubjectId, isUiLanguage } from '@evtivity/lib';
import { writeAudit } from './lib/audit.js';
import type { AuditActor } from './lib/audit.js';
import { computeInsightScopeCounts } from './lib/insight-scope.js';
import { applyConnectorStatus } from './lib/station-status.js';
import { aiInsightAuditLog, aiProposalAuditLog } from './schema/audit.js';

// Demo automatic insights (the AI Insights page, the dashboard card, the
// station and session cards): at least one insight of every kind that is
// not a reservation kind (those come from seed-reservation-insights.ts), and
// every shown status. No model call: each row has the shape the insight
// service writes (`@evtivity/services/ai-insight.service`):
// - scan kinds (station offline, faulted, alert, session failed, token
//   refusal, site incident) with the trigger key of the insight scan, on the
//   trigger row the projection writes (connection log, port status log,
//   event alert, authorize attempt), as `activateInsight` stores them: a
//   known cause in RULE_INSIGHTS is a rule insight without text, every other
//   one carries a canonical text (`generated_by = 'model'`, no provider: the
//   demo text was written, not generated) and claims the cooldown;
// - background worker suggestions (`storeWorkerActionInsight`) with their
//   action (`ai_proposals`) in the state that leaves the insight pending,
//   done, rejected or expired, audited like `ai-proposal.service`;
// - worker summaries and tariff findings (`storeWorkerInsight`).
// Stations are security profile 3 simulator stations: their simulators are
// disabled, so they stay offline and an open station insight stays open
// (the scan resolves an offline insight once its station is online).
// Idempotent (P7): fixed insight, action and session ids. An insight that
// exists is skipped with everything it needs; every insert is ON CONFLICT DO
// NOTHING. The trigger keys equal the scan's, so a running worker that reads
// the trigger rows creates nothing twice.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The fixed ids of the demo rows (`<prefix>_` plus 12 characters). */
export const AI_INSIGHT_DEMO_IDS = {
  stationOffline: 'ain_aidemo000001',
  connectionDrops: 'ain_aidemo000002',
  stationFaulted: 'ain_aidemo000003',
  stationFaultCleared: 'ain_aidemo000004',
  stationAlert: 'ain_aidemo000005',
  siteIncident: 'ain_aidemo000006',
  incidentMembers: ['ain_aidemo000007', 'ain_aidemo000008', 'ain_aidemo000009'],
  sessionFailed: 'ain_aidemo000010',
  authorizationRefused: 'ain_aidemo000011',
  stuckPending: 'ain_aidemo000012',
  stuckDone: 'ain_aidemo000013',
  stuckRejected: 'ain_aidemo000014',
  longFaultedPending: 'ain_aidemo000015',
  longFaultedExpired: 'ain_aidemo000016',
  siteSummary: 'ain_aidemo000017',
  companySummary: 'ain_aidemo000018',
  tariffAnomaly: 'ain_aidemo000019',
} as const;

export const AI_INSIGHT_DEMO_ACTION_IDS = {
  stuckPending: 'apr_aidemo000001',
  stuckDone: 'apr_aidemo000002',
  stuckRejected: 'apr_aidemo000003',
  longFaultedPending: 'apr_aidemo000004',
  longFaultedExpired: 'apr_aidemo000005',
} as const;

export const AI_INSIGHT_DEMO_SESSION_IDS = {
  stale: 'ses_aidemo000001',
  stuck: 'ses_aidemo000002',
  stopped: 'ses_aidemo000003',
  unplugged: 'ses_aidemo000004',
  zeroCost: 'ses_aidemo000005',
} as const;

/** Fixed OCPP 2.1 transaction ids (UUIDs) of the demo sessions. */
const DEMO_TRANSACTION_IDS = {
  stale: '6f1c2a40-5e1d-4c3b-9a01-000000a10001',
  stuck: '6f1c2a40-5e1d-4c3b-9a01-000000a10002',
  stopped: '6f1c2a40-5e1d-4c3b-9a01-000000a10003',
  unplugged: '6f1c2a40-5e1d-4c3b-9a01-000000a10004',
  zeroCost: '6f1c2a40-5e1d-4c3b-9a01-000000a10005',
} as const;

/** The stuck-session action TTL of the worker (`stuck_sessions`, 2 h). */
const STUCK_ACTION_TTL_MS = 2 * HOUR_MS;
/** The worker's stuck-session idle threshold default (`aiWorkers.stuckSessions.idleMinutes`). */
const STUCK_IDLE_MINUTES = 90;

export interface AiInsightDemoInput {
  now: Date;
  /** The company currency (sessions and the tariff finding). */
  currency: string;
  /** The driver of the demo sessions. */
  driverId: string;
  /** The operator who confirmed, rejected and dismissed; null skips those rows. */
  actorUserId: string | null;
  /** `SETTINGS_ENCRYPTION_KEY`: the authorization subject hash; empty skips that insight. */
  subjectSecret: string;
}

interface DemoStation {
  id: string;
  ocppId: string;
  siteId: string | null;
  siteName: string | null;
  evseUuid: string | null;
  evseNumber: number | null;
  connectorNumber: number | null;
}

interface DemoInsightRow {
  id: string;
  kind: InsightKind;
  subjectType: 'station' | 'session' | 'authorization' | 'site' | 'company';
  subjectId: string;
  triggerKey: string;
  status: InsightVisibleStatus | 'superseded';
  siteId: string | null;
  stationId?: string | null;
  sessionId?: string | null;
  authorizeAttemptId?: number | null;
  parentInsightId?: string | null;
  category: RootCauseCategory | null;
  confidence: InsightConfidence | null;
  fixes: readonly FixCode[];
  scope: InsightScope;
  evidenceRefs: string[];
  generatedBy: 'model' | 'rule' | null;
  language: string;
  /** The canonical text; null for a rule insight and a worker suggestion without a rationale. */
  summary: string | null;
  createdAt: Date;
  basisAt: Date | null;
  updatedAt?: Date;
  resolvedAt?: Date | null;
  dismissedAt?: Date | null;
  dismissedBy?: string | null;
}

interface DemoActionRow {
  id: string;
  insightId: string;
  job: AiWorkerJob;
  station: DemoStation;
  sessionId: string | null;
  action: AiWorkerAction;
  args: Record<string, unknown>;
  summary: Record<string, unknown>;
  precondition: { kind: string; params: Record<string, unknown> };
  dedupKey: string;
  status: 'pending' | 'executed' | 'rejected' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  result: { httpStatus: number; body?: unknown } | null;
}

interface Context {
  sql: postgres.Sql;
  input: AiInsightDemoInput;
  /** `aiInsights.primaryLanguage` (rule insights). */
  language: string;
  cooldownMinutes: number;
  ago: (minutes: number) => Date;
  created: number;
}

/** Demo texts are English: the viewer's language gets a translation like any insight. */
const TEXT_LANGUAGE = 'en';

function workerAction(kind: AiWorkerActionKind): AiWorkerAction {
  // Every demo station speaks OCPP 2.1.
  const action = AI_WORKER_ACTIONS.find((a) => a.kind === kind && a.ocppVersion === '2.1');
  if (action === undefined) throw new Error(`No worker action ${kind} for OCPP 2.1`);
  return action;
}

function quarterHour(at: Date): string {
  const slot = new Date(at);
  slot.setUTCMinutes(Math.floor(slot.getUTCMinutes() / 15) * 15, 0, 0);
  return slot.toISOString().slice(0, 16);
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MINUTE_MS);
}

async function settingValue(sql: postgres.Sql, key: string): Promise<unknown> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return row?.value;
}

async function insightExists(sql: postgres.Sql, id: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM ai_insights WHERE id = ${id}`;
  return row != null;
}

/** Inserts the insight and its canonical text. False when it exists (P7). */
async function insertInsight(ctx: Context, i: DemoInsightRow): Promise<boolean> {
  const { sql } = ctx;
  const rows = await sql`
    INSERT INTO ai_insights (
      id, kind, subject_type, subject_id, station_id, session_id, authorize_attempt_id, site_id,
      parent_insight_id, trigger_key, status, category, confidence, fixes, scope, evidence_refs,
      basis_at, primary_language, generated_by, created_at, updated_at, resolved_at,
      dismissed_at, dismissed_by
    )
    VALUES (
      ${i.id}, ${i.kind}, ${i.subjectType}, ${i.subjectId}, ${i.stationId ?? null},
      ${i.sessionId ?? null}, ${i.authorizeAttemptId ?? null}, ${i.siteId},
      ${i.parentInsightId ?? null}, ${i.triggerKey.slice(0, 200)}, ${i.status}, ${i.category},
      ${i.confidence}, ${sql.json(i.fixes.map((code) => ({ code })))}, ${sql.json(i.scope)},
      ${sql.json(i.evidenceRefs)}, ${i.basisAt}, ${i.language}, ${i.generatedBy}, ${i.createdAt},
      ${i.updatedAt ?? i.createdAt}, ${i.resolvedAt ?? null}, ${i.dismissedAt ?? null},
      ${i.dismissedBy ?? null}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) return false;
  ctx.created += 1;
  if (i.summary != null) {
    await sql`
      INSERT INTO ai_insight_texts (insight_id, language, summary, status, source, created_at, updated_at)
      VALUES (${i.id}, ${i.language}, ${i.summary}, 'ready', 'generated', ${i.createdAt}, ${i.createdAt})
      ON CONFLICT DO NOTHING
    `;
  }
  // A generated insight claimed the subject's cooldown (`claimInsightCooldown`).
  if (i.generatedBy === 'model' && i.basisAt != null && i.subjectType !== 'company') {
    const nextAllowedAt = new Date(i.basisAt.getTime() + ctx.cooldownMinutes * MINUTE_MS);
    await sql`
      INSERT INTO ai_insight_cooldowns
        (subject_type, subject_id, kind, next_allowed_at, claimed_by_insight_id, updated_at)
      VALUES (${i.subjectType}, ${i.subjectId}, ${i.kind}, ${nextAllowedAt}, ${i.id}, ${i.basisAt})
      ON CONFLICT DO NOTHING
    `;
  }
  return true;
}

async function auditInsight(
  id: string,
  actorUserId: string,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAudit(
    { table: aiInsightAuditLog, idColumn: 'ai_insight_id' },
    {
      entityId: id,
      entityIdSnapshot: id,
      action: 'dismissed',
      actor: 'operator',
      actorUserId,
      after,
    },
  );
}

async function auditAction(
  id: string,
  action: 'created' | 'confirmed' | 'executed' | 'rejected' | 'expired',
  actor: { actor: AuditActor; actorUserId?: string | null; actorLabel?: string | null },
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAudit(
    { table: aiProposalAuditLog, idColumn: 'ai_proposal_id' },
    {
      entityId: id,
      entityIdSnapshot: id,
      action,
      actor: actor.actor,
      actorUserId: actor.actorUserId ?? null,
      actorLabel: actor.actorLabel ?? null,
      before,
      after,
      viaAi: null,
    },
  );
}

/** Inserts the action and its audit trail, as `ai-proposal.service` writes them. */
async function insertAction(ctx: Context, a: DemoActionRow): Promise<void> {
  const { sql } = ctx;
  const rows = await sql`
    INSERT INTO ai_proposals (
      id, job, insight_id, worker_run_id, site_id, station_id, session_id, operation_id, method,
      path, args, args_hash, summary, precondition, dedup_key, status, expires_at, decided_by,
      decided_at, executed_at, result, created_at, updated_at
    )
    VALUES (
      ${a.id}, ${a.job}, ${a.insightId}, ${null}, ${a.station.siteId}, ${a.station.id},
      ${a.sessionId}, ${a.action.operationId}, ${a.action.method}, ${a.action.path},
      ${sql.json(a.args as postgres.JSONValue)}, ${aiArgsHash(a.args)},
      ${sql.json(a.summary as postgres.JSONValue)}, ${sql.json(a.precondition as postgres.JSONValue)},
      ${a.dedupKey}, ${a.status}, ${a.expiresAt}, ${a.decidedBy}, ${a.decidedAt}, ${a.executedAt},
      ${a.result == null ? null : sql.json(a.result as postgres.JSONValue)}, ${a.createdAt},
      ${a.executedAt ?? a.decidedAt ?? (a.status === 'expired' ? a.expiresAt : a.createdAt)}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) return;
  const pending = { status: 'pending' };
  await auditAction(a.id, 'created', { actor: 'system', actorLabel: `ai-${a.job}` }, null, {
    status: 'pending',
    decidedBy: null,
    operationId: a.action.operationId,
    job: a.job,
    insightId: a.insightId,
    args: a.args,
  });
  if (a.status === 'executed' && a.decidedBy != null) {
    const operator = { actor: 'operator' as const, actorUserId: a.decidedBy };
    await auditAction(a.id, 'confirmed', operator, pending, {
      status: 'pending',
      decidedBy: a.decidedBy,
    });
    await auditAction(
      a.id,
      'executed',
      operator,
      { ...pending, decidedBy: a.decidedBy },
      { status: 'executed', result: a.result },
    );
  } else if (a.status === 'rejected' && a.decidedBy != null) {
    await auditAction(a.id, 'rejected', { actor: 'operator', actorUserId: a.decidedBy }, pending, {
      status: 'rejected',
    });
  } else if (a.status === 'expired') {
    await auditAction(
      a.id,
      'expired',
      { actor: 'system', actorLabel: 'ai-proposal-sweep' },
      pending,
      {
        status: 'expired',
      },
    );
  }
}

async function insertConnectionLog(
  sql: postgres.Sql,
  stationId: string,
  event: 'connected' | 'disconnected',
  at: Date,
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO connection_logs (station_id, event, protocol, remote_address, created_at)
    VALUES (${stationId}, ${event}, ${event === 'connected' ? 'ocpp2.1' : null}, '10.20.0.14', ${at})
    RETURNING id
  `;
  if (row == null) throw new Error(`Demo connection log for ${stationId} not written`);
  return row.id;
}

interface DemoSession {
  id: string;
  station: DemoStation;
  transactionId: string;
  status: 'active' | 'completed' | 'faulted';
  startedAt: Date;
  endedAt: Date | null;
  /** The last update the station sent (`updated_at`). */
  lastActivityAt: Date;
  energyWh: number;
  stoppedReason: string | null;
  finalCostCents: number | null;
  tariffPricePerKwh: string | null;
}

async function insertSession(ctx: Context, s: DemoSession): Promise<void> {
  await ctx.sql`
    INSERT INTO charging_sessions (
      id, station_id, evse_id, driver_id, transaction_id, status, started_at, ended_at,
      meter_start, meter_stop, energy_delivered_wh, current_cost_cents, final_cost_cents,
      tariff_price_per_kwh, currency, stopped_reason, created_at, updated_at
    )
    VALUES (
      ${s.id}, ${s.station.id}, ${s.station.evseUuid}, ${ctx.input.driverId}, ${s.transactionId},
      ${s.status}, ${s.startedAt}, ${s.endedAt}, 0, ${s.endedAt == null ? null : s.energyWh},
      ${String(s.energyWh)}, ${s.finalCostCents}, ${s.finalCostCents}, ${s.tariffPricePerKwh},
      ${ctx.input.currency}, ${s.stoppedReason}, ${s.startedAt}, ${s.lastActivityAt}
    )
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Security profile 3 simulator stations on OCPP 2.1 that stay offline: no
 * active session (other than a demo one) and no demo reservation.
 */
async function demoStations(sql: postgres.Sql): Promise<DemoStation[]> {
  const rows = await sql<
    {
      id: string;
      station_id: string;
      site_id: string | null;
      site_name: string | null;
      evse_uuid: string | null;
      evse_number: number | null;
      connector_number: number | null;
    }[]
  >`
    SELECT cs.id, cs.station_id, cs.site_id, s.name AS site_name,
      e.id AS evse_uuid, e.evse_id AS evse_number, c.connector_id AS connector_number
    FROM charging_stations cs
    LEFT JOIN sites s ON s.id = cs.site_id
    LEFT JOIN LATERAL (
      SELECT id, evse_id FROM evses WHERE station_id = cs.id ORDER BY evse_id LIMIT 1
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT connector_id FROM connectors WHERE evse_id = e.id ORDER BY connector_id LIMIT 1
    ) c ON true
    WHERE cs.security_profile = 3 AND cs.is_simulator AND NOT cs.is_online
      AND cs.disabled_reason IS NULL AND cs.ocpp_protocol = 'ocpp2.1'
      AND NOT EXISTS (
        SELECT 1 FROM charging_sessions cx
        WHERE cx.station_id = cs.id AND cx.status = 'active' AND cx.id NOT LIKE 'ses_aidemo%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM reservations r WHERE r.station_id = cs.id AND r.id LIKE 'rsv_aidemo%'
      )
    ORDER BY cs.station_id
  `;
  return rows.map((r) => ({
    id: r.id,
    ocppId: r.station_id,
    siteId: r.site_id,
    siteName: r.site_name,
    evseUuid: r.evse_uuid,
    evseNumber: r.evse_number,
    connectorNumber: r.connector_number,
  }));
}

/** Stations of different sites first, so the insights spread over the sites. */
function spreadBySite(stations: readonly DemoStation[]): DemoStation[] {
  const bySite = new Map<string, DemoStation[]>();
  for (const s of stations) {
    const key = s.siteId ?? '';
    const list = bySite.get(key) ?? [];
    list.push(s);
    bySite.set(key, list);
  }
  const out: DemoStation[] = [];
  const queues = [...bySite.values()];
  for (let round = 0; out.length < stations.length; round++) {
    for (const q of queues) {
      const s = q[round];
      if (s !== undefined) out.push(s);
    }
  }
  return out;
}

const scopeOf = (ctx: Context, siteId: string | null, stoppedReason?: string) =>
  computeInsightScopeCounts(
    { siteId, ...(stoppedReason !== undefined ? { stoppedReason } : {}) },
    ctx.sql,
  );

// ---------------------------------------------------------------------------
// Station insights (scan kinds)
// ---------------------------------------------------------------------------

/** Offline for hours: the disconnect without a clean shutdown, no reconnect since. */
async function seedStationOffline(ctx: Context, st: DemoStation): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.stationOffline;
  if (await insightExists(ctx.sql, id)) return;
  const connected = await insertConnectionLog(ctx.sql, st.id, 'connected', ctx.ago(9 * 60));
  const disconnected = await insertConnectionLog(ctx.sql, st.id, 'disconnected', ctx.ago(5 * 60));
  const basisAt = ctx.ago(5 * 60 - 2);
  await insertInsight(ctx, {
    id,
    kind: 'station_offline',
    subjectType: 'station',
    subjectId: st.id,
    triggerKey: `station_offline:${st.id}:${String(disconnected)}`,
    status: 'open',
    siteId: st.siteId,
    stationId: st.id,
    category: 'connectivity',
    confidence: 'medium',
    fixes: ['check_network_connection', 'check_power_supply'],
    scope: await scopeOf(ctx, st.siteId),
    evidenceRefs: [`conn:${String(disconnected)}`, `conn:${String(connected)}`],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `${st.ocppId} closed its connection about 5 hours ago after 4 hours online and has not ` +
      'reconnected since. It reported no fault and no status change before the drop, so the ' +
      'charger itself looks healthy. Check the network link at the station first, then its ' +
      'power supply.',
    createdAt: basisAt,
    basisAt,
  });
}

/** Repeated connection drops, dismissed by an operator. */
async function seedConnectionDrops(ctx: Context, st: DemoStation): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.connectionDrops;
  if (await insightExists(ctx.sql, id)) return;
  const refs: string[] = [];
  let lastDisconnect = 0;
  // Four short sessions on the socket in the last 80 minutes.
  for (const start of [80, 58, 37, 16]) {
    const c = await insertConnectionLog(ctx.sql, st.id, 'connected', ctx.ago(start));
    lastDisconnect = await insertConnectionLog(ctx.sql, st.id, 'disconnected', ctx.ago(start - 6));
    refs.unshift(`conn:${String(c)}`);
    refs.unshift(`conn:${String(lastDisconnect)}`);
  }
  const basisAt = ctx.ago(8);
  await insertInsight(ctx, {
    id,
    kind: 'station_offline',
    subjectType: 'station',
    subjectId: st.id,
    triggerKey: `station_offline:${st.id}:${String(lastDisconnect)}`,
    status: ctx.input.actorUserId != null ? 'dismissed' : 'open',
    siteId: st.siteId,
    stationId: st.id,
    category: 'connectivity',
    confidence: 'medium',
    fixes: ['check_network_connection', 'update_firmware', 'contact_station_vendor'],
    scope: await scopeOf(ctx, st.siteId),
    evidenceRefs: refs.slice(0, 6),
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `${st.ocppId} connected and dropped 4 times in the last 80 minutes, staying online about ` +
      '6 minutes each time. A station that keeps reconnecting on its own points to an unstable ' +
      'network link or a firmware problem that restarts the connection. Check the network link ' +
      'and the firmware version, and contact the vendor if the drops continue.',
    createdAt: basisAt,
    basisAt,
    ...(ctx.input.actorUserId != null
      ? { dismissedAt: ctx.ago(3), dismissedBy: ctx.input.actorUserId, updatedAt: ctx.ago(3) }
      : {}),
  });
  if (ctx.input.actorUserId != null) {
    await auditInsight(id, ctx.input.actorUserId, { status: 'dismissed' });
  }
}

/** A connector that reported Faulted 7 hours ago and still is (the faulted state is real). */
async function seedStationFaulted(ctx: Context, st: DemoStation): Promise<Date | null> {
  const id = AI_INSIGHT_DEMO_IDS.stationFaulted;
  if (st.evseNumber == null || st.connectorNumber == null) return null;
  const faultedSince = ctx.ago(7 * 60);
  if (await insightExists(ctx.sql, id)) return faultedSince;
  // The single writer of connector status writes the log row; its time is the fault time.
  await applyConnectorStatus(ctx.sql, {
    stationUuid: st.id,
    evseId: st.evseNumber,
    connectorId: st.connectorNumber,
    status: 'faulted',
    timestamp: faultedSince.toISOString(),
  });
  const [log] = await ctx.sql<{ id: number }[]>`
    SELECT id FROM port_status_log
    WHERE station_id = ${st.id} AND evse_id = ${st.evseNumber}
      AND connector_id = ${st.connectorNumber} AND new_status = 'faulted'
    ORDER BY id DESC LIMIT 1
  `;
  if (log == null) throw new Error(`Demo fault of ${st.ocppId} not logged`);
  await ctx.sql`
    UPDATE port_status_log SET timestamp = ${faultedSince}, created_at = ${faultedSince}
    WHERE id = ${log.id}
  `;
  const basisAt = ctx.ago(7 * 60 - 2);
  await insertInsight(ctx, {
    id,
    kind: 'station_faulted',
    subjectType: 'station',
    subjectId: st.id,
    triggerKey: `station_faulted:${st.id}:${String(log.id)}`,
    status: 'open',
    siteId: st.siteId,
    stationId: st.id,
    category: 'hardware',
    confidence: 'medium',
    fixes: ['inspect_connector', 'reboot_station'],
    scope: await scopeOf(ctx, st.siteId),
    evidenceRefs: [`status:${String(log.id)}`],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `Connector ${String(st.connectorNumber)} of EVSE ${String(st.evseNumber)} on ${st.ocppId} ` +
      'reported Faulted about 7 hours ago and has reported no other status since. No session ' +
      'was running at the time, so the fault comes from the connector or its power electronics ' +
      'rather than a vehicle. Inspect the connector and cable, then reboot the station if the ' +
      'connector looks undamaged.',
    createdAt: basisAt,
    basisAt,
  });
  return faultedSince;
}

/** A connector fault that cleared 20 minutes later: resolved. */
async function seedStationFaultCleared(ctx: Context, st: DemoStation): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.stationFaultCleared;
  if (await insightExists(ctx.sql, id)) return;
  const evse = st.evseNumber ?? 1;
  const connector = st.connectorNumber ?? 1;
  // Status history only: the connector stays as it is (available).
  const [faulted] = await ctx.sql<{ id: number }[]>`
    INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp, created_at)
    VALUES (${st.id}, ${evse}, ${connector}, 'available', 'faulted', ${ctx.ago(200)}, ${ctx.ago(200)})
    RETURNING id
  `;
  const [cleared] = await ctx.sql<{ id: number }[]>`
    INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp, created_at)
    VALUES (${st.id}, ${evse}, ${connector}, 'faulted', 'available', ${ctx.ago(180)}, ${ctx.ago(180)})
    RETURNING id
  `;
  if (faulted == null || cleared == null)
    throw new Error(`Demo status log of ${st.ocppId} not written`);
  const basisAt = ctx.ago(198);
  await insertInsight(ctx, {
    id,
    kind: 'station_faulted',
    subjectType: 'station',
    subjectId: st.id,
    triggerKey: `station_faulted:${st.id}:${String(faulted.id)}`,
    status: 'resolved',
    siteId: st.siteId,
    stationId: st.id,
    category: 'hardware',
    confidence: 'low',
    fixes: ['inspect_connector', 'monitor'],
    scope: await scopeOf(ctx, st.siteId),
    evidenceRefs: [`status:${String(faulted.id)}`],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `Connector ${String(connector)} of EVSE ${String(evse)} on ${st.ocppId} reported ` +
      'Faulted with no session running and no earlier warning. A single fault without a ' +
      'pattern can be a transient self-test failure. Inspect the connector if it faults again.',
    createdAt: basisAt,
    basisAt,
    resolvedAt: ctx.ago(179),
    updatedAt: ctx.ago(179),
  });
}

/** A critical NotifyEvent alert: a ground fault on a connector. */
async function seedStationAlert(ctx: Context, st: DemoStation): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.stationAlert;
  if (await insightExists(ctx.sql, id)) return;
  const at = ctx.ago(95);
  const [alert] = await ctx.sql<{ id: number }[]>`
    INSERT INTO event_alerts (station_id, component, variable, severity, trigger, actual_value, tech_info, created_at)
    VALUES (${st.id}, 'Connector', 'Problem', 1, 'Alerting', 'true', 'GroundFault: residual current 32 mA', ${at})
    RETURNING id
  `;
  if (alert == null) throw new Error(`Demo alert of ${st.ocppId} not written`);
  const basisAt = ctx.ago(93);
  await insertInsight(ctx, {
    id,
    kind: 'station_alert',
    subjectType: 'station',
    subjectId: st.id,
    triggerKey: `station_alert:${st.id}:${String(alert.id)}`,
    status: 'open',
    siteId: st.siteId,
    stationId: st.id,
    category: 'hardware',
    confidence: 'high',
    fixes: ['inspect_connector', 'contact_station_vendor'],
    scope: await scopeOf(ctx, st.siteId),
    evidenceRefs: [`alert:${String(alert.id)}`],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `${st.ocppId} raised a critical Connector Problem alert reporting a ground fault. The ` +
      'residual current device tripped, which points to damaged cable insulation or moisture in ' +
      'the connector. Keep the connector out of use, inspect the cable and connector, and ' +
      'contact the station vendor if the insulation is intact.',
    createdAt: basisAt,
    basisAt,
  });
}

/** Three stations of one site dropped together: one site incident with three members. */
async function seedSiteIncident(ctx: Context, members: readonly DemoStation[]): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.siteIncident;
  const first = members[0];
  if (first == null || first.siteId == null || members.length < 3) return;
  if (await insightExists(ctx.sql, id)) return;
  const siteId = first.siteId;
  const memberIds = AI_INSIGHT_DEMO_IDS.incidentMembers;
  const refs: string[] = [];
  const memberRows: DemoInsightRow[] = [];
  for (const [n, st] of members.slice(0, 3).entries()) {
    const memberId = memberIds[n];
    if (memberId === undefined) continue;
    await insertConnectionLog(ctx.sql, st.id, 'connected', ctx.ago(12 * 60 + n));
    const disconnected = await insertConnectionLog(ctx.sql, st.id, 'disconnected', ctx.ago(47 - n));
    refs.push(`station:${st.id}`, `conn:${String(disconnected)}`);
    memberRows.push({
      id: memberId,
      kind: 'station_offline',
      subjectType: 'station',
      subjectId: st.id,
      triggerKey: `station_offline:${st.id}:${String(disconnected)}`,
      status: 'superseded',
      siteId,
      stationId: st.id,
      parentInsightId: id,
      category: null,
      confidence: null,
      fixes: [],
      scope: {},
      evidenceRefs: [],
      generatedBy: null,
      language: ctx.language,
      summary: null,
      createdAt: ctx.ago(45 - n),
      basisAt: null,
    });
  }
  const basisAt = ctx.ago(43);
  // The incident's id is the first member's: the members follow it.
  const firstMember = memberRows.map((m) => m.id).sort((a, b) => a.localeCompare(b))[0] ?? '';
  await insertInsight(ctx, {
    id,
    kind: 'site_incident',
    subjectType: 'site',
    subjectId: siteId,
    triggerKey: `site_incident:${siteId}:${firstMember}`,
    status: 'open',
    siteId,
    category: 'connectivity',
    confidence: 'high',
    fixes: ['check_network_connection', 'check_power_supply'],
    scope: await scopeOf(ctx, siteId),
    evidenceRefs: refs,
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `Three stations at ${first.siteName ?? 'this site'} (${members
        .slice(0, 3)
        .map((m) => m.ocppId)
        .join(', ')}) disconnected within 2 minutes of each other about 45 minutes ago, and ` +
      'none has reconnected. Stations that drop together share a cause upstream of the ' +
      'chargers. Check the site network link and router first, then the shared power feed.',
    createdAt: basisAt,
    basisAt,
  });
  for (const m of memberRows) await insertInsight(ctx, m);
}

// ---------------------------------------------------------------------------
// Session and authorization insights (scan kinds)
// ---------------------------------------------------------------------------

/** A session the stale-session cleanup faulted: the end never arrived. */
async function seedSessionFailed(ctx: Context, st: DemoStation): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.sessionFailed;
  if (await insightExists(ctx.sql, id)) return;
  const stored = await settingValue(ctx.sql, 'session.staleTimeoutHours');
  const timeoutHours = typeof stored === 'number' && stored > 0 ? stored : 24;
  const endedAt = ctx.ago(70);
  const lastActivityAt = new Date(endedAt.getTime() - timeoutHours * HOUR_MS);
  const session: DemoSession = {
    id: AI_INSIGHT_DEMO_SESSION_IDS.stale,
    station: st,
    transactionId: DEMO_TRANSACTION_IDS.stale,
    status: 'faulted',
    startedAt: new Date(lastActivityAt.getTime() - 35 * MINUTE_MS),
    endedAt,
    lastActivityAt: endedAt,
    energyWh: 6400,
    stoppedReason: 'StaleSession',
    finalCostCents: 0,
    tariffPricePerKwh: null,
  };
  await insertSession(ctx, session);
  const basisAt = ctx.ago(68);
  await insertInsight(ctx, {
    id,
    kind: 'session_failed',
    subjectType: 'session',
    subjectId: session.id,
    triggerKey: `session_failed:${session.id}`,
    status: 'open',
    siteId: st.siteId,
    stationId: st.id,
    sessionId: session.id,
    category: 'connectivity',
    confidence: 'medium',
    fixes: ['check_network_connection', 'reboot_station'],
    scope: await scopeOf(ctx, st.siteId, 'StaleSession'),
    evidenceRefs: [],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `This session on ${st.ocppId} delivered 6.4 kWh in its first 35 minutes, then the ` +
      `station sent no further update for ${String(timeoutHours)} hours. The stale-session ` +
      'cleanup closed it as faulted and did not bill it. The end of the transaction never ' +
      'arrived, which points to a lost connection during the session. Check the station network ' +
      'link and reboot the station if it does not reconnect.',
    createdAt: basisAt,
    basisAt,
  });
}

/** One token refused 4 times at one station within an hour (a known cause: a rule insight). */
async function seedAuthorizationRefused(ctx: Context): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.authorizationRefused;
  if (ctx.input.subjectSecret === '') {
    console.log('  Skipping the demo authorization insight: SETTINGS_ENCRYPTION_KEY is not set.');
    return;
  }
  if (await insightExists(ctx.sql, id)) return;
  const [token] = await ctx.sql<
    { id: string; id_token: string; token_type: string; driver_id: string }[]
  >`
    SELECT id, id_token, token_type, driver_id FROM driver_tokens
    WHERE NOT is_active AND revoked_at IS NULL AND driver_id IS NOT NULL
    ORDER BY id_token LIMIT 1
  `;
  const [station] = await ctx.sql<{ id: string; station_id: string; site_id: string | null }[]>`
    SELECT id, station_id, site_id FROM charging_stations
    WHERE security_profile <> 3 AND ocpp_protocol = 'ocpp2.1' AND disabled_reason IS NULL
      AND site_id IS NOT NULL
    ORDER BY station_id LIMIT 1
  `;
  if (token == null || station == null) {
    console.log('  Skipping the demo authorization insight: no inactive token or station.');
    return;
  }
  // The four attempts fall in one UTC hour: the previous full hour.
  const hourStart = new Date(ctx.input.now);
  hourStart.setUTCMinutes(0, 0, 0);
  hourStart.setTime(hourStart.getTime() - HOUR_MS);
  const attemptIds: number[] = [];
  for (const minute of [8, 19, 31, 44]) {
    const [row] = await ctx.sql<{ id: number }[]>`
      INSERT INTO authorize_attempts (
        station_id, id_token, token_type, matched_token_id, matched_driver_id, outcome,
        ocpp_version, reason, created_at
      )
      VALUES (
        ${station.station_id}, ${token.id_token}, ${token.token_type}, ${token.id},
        ${token.driver_id}, 'blocked', 'ocpp2.1', 'inactive',
        ${new Date(hourStart.getTime() + minute * MINUTE_MS)}
      )
      RETURNING id
    `;
    if (row != null) attemptIds.push(row.id);
  }
  const firstAttempt = attemptIds[0];
  if (firstAttempt === undefined) return;
  const rule = RULE_INSIGHTS['blocked'] ?? INSIGHT_KIND_FALLBACKS.authorization_refused;
  const subjectId = authorizationSubjectId(station.id, token.id_token, ctx.input.subjectSecret);
  const basisAt = new Date(hourStart.getTime() + 10 * MINUTE_MS);
  await insertInsight(ctx, {
    id,
    kind: 'authorization_refused',
    subjectType: 'authorization',
    subjectId,
    triggerKey: `authorization_refused:${subjectId}:${hourStart.toISOString().slice(0, 13)}`,
    status: 'open',
    siteId: station.site_id,
    stationId: station.id,
    authorizeAttemptId: firstAttempt,
    category: rule.category,
    confidence: 'high',
    fixes: rule.fixes,
    scope: await scopeOf(ctx, station.site_id),
    evidenceRefs: [],
    generatedBy: 'rule',
    language: ctx.language,
    summary: null,
    createdAt: basisAt,
    basisAt,
  });
}

// ---------------------------------------------------------------------------
// Background worker suggestions (insights that carry an action)
// ---------------------------------------------------------------------------

interface StuckPlan {
  insightId: string;
  actionId: string;
  session: DemoSession;
  reason: 'station_offline' | 'no_activity';
  /** When the worker suggested the stop. */
  suggestedAt: Date;
  status: 'pending' | 'done' | 'rejected';
  summary: string;
}

/** The root cause the stuck-session worker gives each reason (`STUCK_ROOT_CAUSES`). */
const STUCK_ROOT_CAUSE = {
  station_offline: { category: 'connectivity', confidence: 'high' },
  no_activity: { category: 'unknown', confidence: 'low' },
} as const satisfies Record<
  StuckPlan['reason'],
  { category: RootCauseCategory; confidence: InsightConfidence }
>;

const STUCK_RATIONALE = { station_offline: 'stuckSessionOffline', no_activity: 'stuckSessionIdle' };

async function seedStuckSession(ctx: Context, plan: StuckPlan): Promise<void> {
  if (await insightExists(ctx.sql, plan.insightId)) return;
  const decided = plan.status !== 'pending';
  if (decided && ctx.input.actorUserId == null) return;
  const s = plan.session;
  const dedupKey = `stuck_sessions:${s.id}`;
  if (plan.status === 'pending') {
    const [open] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM ai_proposals WHERE dedup_key = ${dedupKey} AND status = 'pending'
    `;
    if (open != null) return;
  }
  await insertSession(ctx, s);
  const action = workerAction('stop_transaction');
  const minutes = Math.max(minutesBetween(s.lastActivityAt, plan.suggestedAt), STUCK_IDLE_MINUTES);
  const decidedAt = decided ? new Date(plan.suggestedAt.getTime() + 25 * MINUTE_MS) : null;
  const rootCause = STUCK_ROOT_CAUSE[plan.reason];
  const status: InsightVisibleStatus = plan.status;
  await insertInsight(ctx, {
    id: plan.insightId,
    kind: 'stuck_session',
    subjectType: 'session',
    subjectId: s.id,
    triggerKey: `${dedupKey}:${quarterHour(plan.suggestedAt)}`,
    status,
    siteId: s.station.siteId,
    stationId: s.station.id,
    sessionId: s.id,
    category: rootCause.category,
    confidence: rootCause.confidence,
    fixes: INSIGHT_KIND_FALLBACKS.stuck_session.fixes,
    scope: {},
    evidenceRefs: [],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary: plan.summary.replace('{minutes}', String(minutes)),
    createdAt: plan.suggestedAt,
    basisAt: plan.suggestedAt,
    updatedAt: decidedAt ?? plan.suggestedAt,
  });
  await insertAction(ctx, {
    id: plan.actionId,
    insightId: plan.insightId,
    job: 'stuck_sessions',
    station: s.station,
    sessionId: s.id,
    action,
    args: { stationId: s.station.ocppId, transactionId: s.transactionId, ...action.fixedArgs },
    summary: {
      action: 'stop_transaction',
      stationId: s.station.ocppId,
      transactionId: s.transactionId,
      reason: plan.reason,
      rationale: { code: STUCK_RATIONALE[plan.reason], params: { minutes } },
      lastActivityAt: s.lastActivityAt.toISOString(),
    },
    precondition: {
      kind: 'session_active',
      params: { sessionId: s.id, transactionId: s.transactionId },
    },
    dedupKey,
    status: plan.status === 'done' ? 'executed' : plan.status,
    createdAt: plan.suggestedAt,
    expiresAt: new Date(plan.suggestedAt.getTime() + STUCK_ACTION_TTL_MS),
    decidedBy: decided ? ctx.input.actorUserId : null,
    decidedAt,
    executedAt: plan.status === 'done' ? decidedAt : null,
    result:
      plan.status === 'done'
        ? {
            httpStatus: 200,
            body: {
              status: 'accepted',
              stationId: s.station.ocppId,
              action: 'RequestStopTransaction',
              response: { status: 'Accepted' },
            },
          }
        : null,
  });
  if (plan.status === 'rejected' && ctx.input.actorUserId != null) {
    await auditInsight(plan.insightId, ctx.input.actorUserId, { status: 'rejected' });
  }
}

async function seedStuckSessions(
  ctx: Context,
  stations: { pending: DemoStation; done: DemoStation; rejected: DemoStation },
): Promise<void> {
  const { ago } = ctx;
  await seedStuckSession(ctx, {
    insightId: AI_INSIGHT_DEMO_IDS.stuckPending,
    actionId: AI_INSIGHT_DEMO_ACTION_IDS.stuckPending,
    reason: 'station_offline',
    status: 'pending',
    suggestedAt: ago(15),
    session: {
      id: AI_INSIGHT_DEMO_SESSION_IDS.stuck,
      station: stations.pending,
      transactionId: DEMO_TRANSACTION_IDS.stuck,
      status: 'active',
      startedAt: ago(4 * 60),
      endedAt: null,
      lastActivityAt: ago(2 * 60),
      energyWh: 14_800,
      stoppedReason: null,
      finalCostCents: null,
      tariffPricePerKwh: null,
    },
    summary:
      `The station has sent nothing for {minutes} minutes and is offline, so it cannot report ` +
      'the end of this transaction. Stopping the session closes it in the CSMS and frees the ' +
      'connector for the next driver.',
  });
  await seedStuckSession(ctx, {
    insightId: AI_INSIGHT_DEMO_IDS.stuckDone,
    actionId: AI_INSIGHT_DEMO_ACTION_IDS.stuckDone,
    reason: 'no_activity',
    status: 'done',
    suggestedAt: ago(4 * 60),
    session: {
      id: AI_INSIGHT_DEMO_SESSION_IDS.stopped,
      station: stations.done,
      transactionId: DEMO_TRANSACTION_IDS.stopped,
      status: 'completed',
      startedAt: ago(8 * 60),
      endedAt: ago(4 * 60 - 26),
      lastActivityAt: ago(5 * 60 + 40),
      energyWh: 31_200,
      stoppedReason: 'Remote',
      finalCostCents: 1092,
      tariffPricePerKwh: null,
    },
    summary:
      'This session sent no meter values or transaction events for {minutes} minutes while the ' +
      'station stayed online, so it is most likely no longer charging. Stopping it ends the ' +
      'transaction on the station and closes the session record.',
  });
  await seedStuckSession(ctx, {
    insightId: AI_INSIGHT_DEMO_IDS.stuckRejected,
    actionId: AI_INSIGHT_DEMO_ACTION_IDS.stuckRejected,
    reason: 'no_activity',
    status: 'rejected',
    suggestedAt: ago(20 * 60),
    session: {
      id: AI_INSIGHT_DEMO_SESSION_IDS.unplugged,
      station: stations.rejected,
      transactionId: DEMO_TRANSACTION_IDS.unplugged,
      status: 'completed',
      startedAt: ago(24 * 60),
      endedAt: ago(18 * 60),
      lastActivityAt: ago(21 * 60 + 45),
      energyWh: 22_500,
      stoppedReason: 'EVDisconnected',
      finalCostCents: 788,
      tariffPricePerKwh: null,
    },
    summary:
      'This session sent no meter values or transaction events for {minutes} minutes while the ' +
      'station stayed online, so it is most likely no longer charging. Stopping it ends the ' +
      'transaction on the station and closes the session record.',
  });
}

/** A soft reset suggested for a station faulted for hours (`network_summary`). */
async function seedLongFaulted(
  ctx: Context,
  plan: {
    insightId: string;
    actionId: string;
    station: DemoStation;
    faultedSince: Date;
    suggestedAt: Date;
    status: 'pending' | 'expired';
  },
): Promise<void> {
  if (await insightExists(ctx.sql, plan.insightId)) return;
  const st = plan.station;
  const dedupKey = `network_summary:soft_reset:${st.id}`;
  if (plan.status === 'pending') {
    const [open] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM ai_proposals WHERE dedup_key = ${dedupKey} AND status = 'pending'
    `;
    if (open != null) return;
  }
  const stored = await settingValue(ctx.sql, 'aiWorkers.proposalTtlHours');
  const ttlHours = typeof stored === 'number' && stored > 0 ? stored : 24;
  const expiresAt = new Date(plan.suggestedAt.getTime() + ttlHours * HOUR_MS);
  const rule = INSIGHT_KIND_FALLBACKS.station_long_faulted;
  // The worker passes no narrative for a soft reset: the action is the text.
  await insertInsight(ctx, {
    id: plan.insightId,
    kind: 'station_long_faulted',
    subjectType: 'station',
    subjectId: st.id,
    triggerKey: `${dedupKey}:${day(plan.suggestedAt)}`,
    status: plan.status,
    siteId: st.siteId,
    stationId: st.id,
    category: rule.category,
    confidence: 'medium',
    fixes: rule.fixes,
    scope: {},
    evidenceRefs: [],
    generatedBy: 'rule',
    language: ctx.language,
    summary: null,
    createdAt: plan.suggestedAt,
    basisAt: plan.suggestedAt,
    updatedAt: plan.status === 'expired' ? expiresAt : plan.suggestedAt,
  });
  const action = workerAction('soft_reset');
  await insertAction(ctx, {
    id: plan.actionId,
    insightId: plan.insightId,
    job: 'network_summary',
    station: st,
    sessionId: null,
    action,
    args: { stationId: st.ocppId, ...action.fixedArgs },
    summary: {
      action: 'soft_reset',
      stationId: st.ocppId,
      faultedSince: plan.faultedSince.toISOString(),
    },
    precondition: { kind: 'station_faulted', params: { stationId: st.id } },
    dedupKey,
    status: plan.status,
    createdAt: plan.suggestedAt,
    expiresAt,
    decidedBy: null,
    decidedAt: null,
    executedAt: null,
    result: null,
  });
}

// ---------------------------------------------------------------------------
// Worker summaries and tariff findings (`storeWorkerInsight`)
// ---------------------------------------------------------------------------

interface ActivityRow {
  site_id: string | null;
  site_name: string | null;
  sessions: number;
  failed: number;
  energy_wh: string | null;
  prior_daily: string | null;
}

/** Sessions, failures and energy per site in the 24 hours before `at`, and the prior 7-day daily average. */
async function siteActivity(sql: postgres.Sql, at: Date): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    SELECT cs.site_id, s.name AS site_name,
      count(*) FILTER (WHERE x.started_at >= ${at}::timestamptz - interval '24 hours')::int AS sessions,
      count(*) FILTER (WHERE x.started_at >= ${at}::timestamptz - interval '24 hours'
        AND x.status IN ('failed', 'faulted'))::int AS failed,
      sum(x.energy_delivered_wh::numeric) FILTER (
        WHERE x.started_at >= ${at}::timestamptz - interval '24 hours')::text AS energy_wh,
      (count(*) FILTER (WHERE x.started_at < ${at}::timestamptz - interval '24 hours') / 7.0)::text
        AS prior_daily
    FROM charging_sessions x
    JOIN charging_stations cs ON cs.id = x.station_id
    LEFT JOIN sites s ON s.id = cs.site_id
    WHERE x.started_at >= ${at}::timestamptz - interval '8 days' AND x.started_at < ${at}
      AND cs.site_id IS NOT NULL
    GROUP BY cs.site_id, s.name
    ORDER BY sessions DESC, cs.site_id
  `;
}

function kwh(wh: string | null): string {
  return (Number(wh ?? 0) / 1000).toFixed(1);
}

function trend(sessions: number, priorDaily: number): string {
  if (priorDaily <= 0) return 'There is no earlier activity to compare with.';
  const ratio = sessions / priorDaily;
  const avg = priorDaily.toFixed(1);
  if (ratio >= 1.15) return `That is above the daily average of ${avg} over the 7 days before.`;
  if (ratio <= 0.85) return `That is below the daily average of ${avg} over the 7 days before.`;
  return `That is in line with the daily average of ${avg} over the 7 days before.`;
}

/** Yesterday's network summary of the busiest site and of the company (the 05:30 run). */
async function seedSummaries(ctx: Context): Promise<void> {
  const runAt = new Date(ctx.input.now.getTime() - 24 * HOUR_MS);
  runAt.setUTCHours(5, 30, 0, 0);
  const rows = await siteActivity(ctx.sql, runAt);
  const active = rows.filter((r) => r.sessions > 0);
  const busiest = active[0];
  if (
    busiest?.site_id != null &&
    !(await insightExists(ctx.sql, AI_INSIGHT_DEMO_IDS.siteSummary))
  ) {
    await insertInsight(ctx, {
      id: AI_INSIGHT_DEMO_IDS.siteSummary,
      kind: 'site_summary',
      subjectType: 'site',
      subjectId: busiest.site_id,
      triggerKey: `network_summary:${day(runAt)}`,
      status: 'open',
      siteId: busiest.site_id,
      category: 'unknown',
      confidence: 'medium',
      fixes: [],
      scope: {},
      evidenceRefs: [],
      generatedBy: 'model',
      language: TEXT_LANGUAGE,
      summary:
        `${busiest.site_name ?? 'The site'} ran ${String(busiest.sessions)} sessions and ` +
        `delivered ${kwh(busiest.energy_wh)} kWh in the 24 hours before this summary. ` +
        `${trend(busiest.sessions, Number(busiest.prior_daily ?? 0))} ` +
        (busiest.failed > 0
          ? `${String(busiest.failed)} of the sessions ended failed or faulted.`
          : 'No session ended failed or faulted.'),
      createdAt: runAt,
      basisAt: runAt,
    });
  }
  if (active.length > 0 && !(await insightExists(ctx.sql, AI_INSIGHT_DEMO_IDS.companySummary))) {
    const sessions = active.reduce((n, r) => n + r.sessions, 0);
    const failed = active.reduce((n, r) => n + r.failed, 0);
    const energyWh = active.reduce((n, r) => n + Number(r.energy_wh ?? 0), 0);
    const prior = rows.reduce((n, r) => n + Number(r.prior_daily ?? 0), 0);
    await insertInsight(ctx, {
      id: AI_INSIGHT_DEMO_IDS.companySummary,
      kind: 'company_summary',
      subjectType: 'company',
      subjectId: 'company',
      triggerKey: `network_summary:${day(runAt)}`,
      status: 'open',
      siteId: null,
      category: 'unknown',
      confidence: 'medium',
      fixes: [],
      scope: {},
      evidenceRefs: [],
      generatedBy: 'model',
      language: TEXT_LANGUAGE,
      summary:
        `${String(active.length)} sites ran ${String(sessions)} sessions and delivered ` +
        `${kwh(String(energyWh))} kWh in the 24 hours before this summary. ` +
        `${trend(sessions, prior)} ` +
        `${busiest?.site_name ?? 'The busiest site'} was the busiest site with ` +
        `${String(busiest?.sessions ?? 0)} sessions. ` +
        (failed > 0
          ? `${String(failed)} sessions ended failed or faulted across the network.`
          : 'No session ended failed or faulted.'),
      createdAt: runAt,
      basisAt: runAt,
    });
  }
}

/** A session billed at zero under a priced tariff: a `zero_cost` finding of `tariff_anomalies`. */
async function seedTariffAnomaly(ctx: Context, st: DemoStation): Promise<void> {
  const id = AI_INSIGHT_DEMO_IDS.tariffAnomaly;
  if (st.siteId == null || (await insightExists(ctx.sql, id))) return;
  const price = 0.35;
  await insertSession(ctx, {
    id: AI_INSIGHT_DEMO_SESSION_IDS.zeroCost,
    station: st,
    transactionId: DEMO_TRANSACTION_IDS.zeroCost,
    status: 'completed',
    startedAt: ctx.ago(7 * 60),
    endedAt: ctx.ago(5 * 60 + 50),
    lastActivityAt: ctx.ago(5 * 60 + 50),
    energyWh: 21_600,
    stoppedReason: 'EVDisconnected',
    finalCostCents: 0,
    tariffPricePerKwh: price.toFixed(4),
  });
  // The run after the session ended.
  const at = ctx.ago(5 * 60);
  await insertInsight(ctx, {
    id,
    kind: 'tariff_anomaly',
    subjectType: 'site',
    subjectId: st.siteId,
    triggerKey: `tariff_anomalies:${day(at)}`,
    status: 'open',
    siteId: st.siteId,
    category: 'tariff',
    confidence: 'medium',
    fixes: ['review_tariff_assignment'],
    scope: {},
    evidenceRefs: [],
    generatedBy: 'model',
    language: TEXT_LANGUAGE,
    summary:
      `A session on ${st.ocppId} at ${st.siteName ?? 'this site'} delivered 21.6 kWh at a ` +
      `tariff price of ${formatUnitPrice(price, ctx.input.currency, 'en-US')} per kWh, yet its ` +
      'final cost is zero and it was not a free vend session. Review the tariff assignment of ' +
      'the station so its sessions are billed.',
    createdAt: at,
    basisAt: at,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Seeds the demo insights, their trigger rows, sessions and actions.
 * Returns the number of insights it created (0 on a rerun).
 */
export async function seedAiInsightsDemo(
  sql: postgres.Sql,
  input: AiInsightDemoInput,
): Promise<number> {
  const storedLanguage = await settingValue(sql, AI_INSIGHT_SETTING_KEYS.primaryLanguage);
  const storedCooldown = await settingValue(sql, AI_INSIGHT_SETTING_KEYS.cooldownMinutes);
  const ctx: Context = {
    sql,
    input,
    language: isUiLanguage(storedLanguage) ? storedLanguage : 'en',
    cooldownMinutes: typeof storedCooldown === 'number' && storedCooldown > 0 ? storedCooldown : 60,
    ago: (minutes) => new Date(input.now.getTime() - minutes * MINUTE_MS),
    created: 0,
  };

  const all = await demoStations(sql);
  if (all.length === 0) {
    console.log('  Skipping the demo AI insights: no offline security profile 3 station.');
    return 0;
  }
  // The incident site: the site with the most such stations (at least 3).
  const counts = new Map<string, number>();
  for (const s of all) if (s.siteId != null) counts.set(s.siteId, (counts.get(s.siteId) ?? 0) + 1);
  const incidentSite = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const incident =
    incidentSite == null ? [] : all.filter((s) => s.siteId === incidentSite).slice(0, 3);
  const rest = spreadBySite(all.filter((s) => !incident.includes(s)));
  const pool = rest.length > 0 ? rest : all;
  const pick = (n: number): DemoStation => pool[n % pool.length] ?? (all[0] as DemoStation);

  await seedStationOffline(ctx, pick(0));
  await seedConnectionDrops(ctx, pick(1));
  const faulted = pick(2);
  const faultedSince = await seedStationFaulted(ctx, faulted);
  if (faultedSince != null) {
    await seedLongFaulted(ctx, {
      insightId: AI_INSIGHT_DEMO_IDS.longFaultedPending,
      actionId: AI_INSIGHT_DEMO_ACTION_IDS.longFaultedPending,
      station: faulted,
      faultedSince,
      suggestedAt: ctx.ago(40),
      status: 'pending',
    });
  }
  const recovered = pick(3);
  await seedLongFaulted(ctx, {
    insightId: AI_INSIGHT_DEMO_IDS.longFaultedExpired,
    actionId: AI_INSIGHT_DEMO_ACTION_IDS.longFaultedExpired,
    station: recovered,
    faultedSince: ctx.ago(40 * 60),
    suggestedAt: ctx.ago(32 * 60),
    status: 'expired',
  });
  await seedStationFaultCleared(ctx, pick(4));
  await seedStationAlert(ctx, pick(5));
  await seedSiteIncident(ctx, incident);
  await seedSessionFailed(ctx, pick(6));
  await seedAuthorizationRefused(ctx);
  await seedStuckSessions(ctx, { pending: pick(7), done: pick(8), rejected: pick(9) });
  await seedSummaries(ctx);
  await seedTariffAnomaly(ctx, pick(10));
  return ctx.created;
}
