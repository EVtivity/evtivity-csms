// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cron `ai-insight-scan` (every minute, decision D3): reads the rows the
 * event projections wrote since the last run, one watermark per source table
 * (`ai_insight_scan_state`), and turns them into analyzing insights. No hook
 * in the OCPP projection lane: failed sessions alone have five writers, and
 * a sweep gives one dedup point. Latency is up to a minute plus the debounce.
 *
 * Sources:
 * - `connection_logs` `disconnected` -> `station_offline`
 * - `port_status_log` to `faulted`, and stations reporting `faulted` -> `station_faulted`
 * - `event_alerts` -> `station_alert`
 * - `authorize_attempts` refused -> `authorization_refused`, one per token,
 *   station and hour (the trigger key groups repeated refusals)
 * - `charging_sessions` that reached `failed` or `faulted` -> `session_failed`;
 *   sessions with the same stop reason at a site within an hour group under
 *   the first
 * - `reservation_audit_log` trigger rows (`RESERVATION_INSIGHT_TRIGGERS`) ->
 *   the reservation kinds, one per audit row; an `expired` row only with
 *   reason `no_show`. No-shows of a site within an hour group under the
 *   first; a station fault during a hold joins the open site incident its
 *   station is a member of
 *
 * Each analyzing insight is inserted first (unique trigger key, P7), then a
 * job with the insight id as job id is queued, delayed by the debounce (P4).
 * When `aiInsights.siteIncidentThreshold` stations of one site went offline
 * or faulted inside the debounce window, one `site_incident` takes them as
 * members (`superseded`, no model call of their own). Pending insights older
 * than the debounce plus 10 minutes are queued again (a lost job). Active
 * station insights whose condition cleared, and incidents whose stations all
 * recovered, end `resolved`. Conformance test stations, their sessions and
 * reservations raise no insight.
 *
 * Watermarks: serial sources read ids up to the highest id older than 10
 * seconds, at most 2000 ids per run; sessions read `(updated_at, id)` the
 * same way. A row whose transaction commits more than 10 seconds after a
 * later id is not seen (a projection commits in milliseconds).
 */

import {
  client,
  getInsightAiSettings,
  stationAvailabilitySql,
  stationInsightsSuppressedSql,
  operatorStationSql,
} from '@evtivity/database';
import type { Logger, PubSubClient } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import {
  AUTHORIZATION_EXPIRE_OUTCOMES,
  INSIGHT_EXPIRE_KINDS,
  isReservationInsightKind,
  RESERVATION_INSIGHT_TRIGGERS,
  reservationAuditRaisesInsight,
  reservationAuditReason,
} from '@evtivity/lib/ai-insights';
import type { InsightKind, ReservationInsightTriggerAction } from '@evtivity/lib/ai-insights';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  attachToIncident,
  createInsight,
  expireInsights,
  publishInsightUpdated,
  readScanWatermark,
  resolveInsights,
  siteInsightsSuppressed,
  writeScanWatermark,
} from '@evtivity/services/ai-insight.service';
import type { NewInsight } from '@evtivity/services/ai-insight.service';
import { authorizationSubjectId } from '@evtivity/lib';
import { enqueueAiInsightJob } from '../ai-insight-worker.js';
import { config } from '../lib/config.js';
import type { AiInsightJobData } from '../ai-insight-worker.js';

/** Rows younger than this are left for the next run (commit lag). */
const COMMIT_LAG_SECONDS = 10;
/** Ids read per source and run. */
const ID_WINDOW = 2000;
/** Session rows read per run. */
const SESSION_BATCH = 500;
/** An analyzing insight this much older than the debounce gets its job again. */
const STUCK_MARGIN_MINUTES = 10;
/** Sessions with the same stop reason at a site group within this window. */
const SESSION_GROUP_MINUTES = 60;
/** Reservation no-shows at a site group within this window (decision E17). */
const NO_SHOW_GROUP_MINUTES = 60;
const RESERVATION_TRIGGER_ACTIONS = Object.keys(
  RESERVATION_INSIGHT_TRIGGERS,
) as ReservationInsightTriggerAction[];

export interface AiInsightScanDeps {
  getSettings: () => Promise<AiSettings>;
  enqueue: (data: AiInsightJobData, delayMs: number) => Promise<void>;
  pubsub: PubSubClient;
  /** Keys the token hash of authorization subjects (SETTINGS_ENCRYPTION_KEY). */
  subjectSecret: string;
}

export interface AiInsightScanSummary {
  created: number;
  incidents: number;
  requeued: number;
  resolved: number;
  /** One-off event insights closed by age (`aiInsights.expireAfterDays`). */
  expired: number;
}

/**
 * Watermark writes of one run. They run after every candidate is stored, so
 * a crash or a failed insert never moves a watermark past unstored rows (P4).
 */
type Marks = (() => Promise<void>)[];

/** Disconnects a stopping OCPP pod logs (graceful-shutdown.ts): not an outage. */
export const SERVER_SHUTDOWN_DISCONNECT_REASON = 'server_shutdown';

interface Candidate {
  insight: NewInsight;
  /** Station offline or faulted: counts toward a site incident. */
  incidentMember: boolean;
}

async function serialCutoff(table: string, lastId: number): Promise<number> {
  const [row] = await client<{ cutoff: string | number | null }[]>`
    SELECT max(id) AS cutoff FROM ${client(table)}
    WHERE id > ${lastId} AND id <= ${lastId + ID_WINDOW}
      AND created_at <= now() - make_interval(secs => ${COMMIT_LAG_SECONDS})
  `;
  if (row?.cutoff != null) return Number(row.cutoff);
  // An id gap wider than the window (a rolled-back bulk insert, a sequence
  // jump): move past it when later rows exist.
  const [later] = await client<{ id: string | number | null }[]>`
    SELECT min(id) AS id FROM ${client(table)}
    WHERE id > ${lastId + ID_WINDOW}
      AND created_at <= now() - make_interval(secs => ${COMMIT_LAG_SECONDS})
  `;
  return later?.id == null ? lastId : Number(later.id) - 1;
}

/**
 * The id window of a serial source: (last, upper]. A source seen for the
 * first time starts at its current maximum (no backfill of history).
 */
async function serialWindow(
  source: string,
  table: string,
): Promise<{ last: number; upper: number } | null> {
  const mark = await readScanWatermark(source);
  if (mark?.lastId == null) {
    const [row] = await client<{ max: string | number | null }[]>`
      SELECT coalesce(max(id), 0) AS max FROM ${client(table)}
    `;
    await writeScanWatermark(source, {
      lastId: Number(row?.max ?? 0),
      lastAt: null,
      lastKey: null,
    });
    return null;
  }
  const upper = await serialCutoff(table, mark.lastId);
  return upper > mark.lastId ? { last: mark.lastId, upper } : null;
}

function hourBucket(at: Date): string {
  return at.toISOString().slice(0, 13);
}

async function offlineCandidates(
  language: string,
  on: boolean,
  marks: Marks,
): Promise<Candidate[]> {
  const window = await serialWindow('connection_logs', 'connection_logs');
  if (window == null) return [];
  const rows = on
    ? await client<{ id: number; station_id: string; site_id: string | null }[]>`
        SELECT l.id, l.station_id, cs.site_id
        FROM connection_logs l
        JOIN charging_stations cs ON cs.id = l.station_id
        LEFT JOIN sites s ON s.id = cs.site_id
        WHERE l.id > ${window.last} AND l.id <= ${window.upper} AND l.event = 'disconnected'
          AND (l.metadata ->> 'reason') IS DISTINCT FROM ${SERVER_SHUTDOWN_DISCONNECT_REASON}
          AND (s.id IS NULL OR s.ai_insights_enabled)
          AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
          AND ${client.unsafe(operatorStationSql('cs'))}
        ORDER BY l.id
      `
    : [];
  marks.push(() =>
    writeScanWatermark('connection_logs', { lastId: window.upper, lastAt: null, lastKey: null }),
  );
  return rows.map((r) => ({
    incidentMember: true,
    insight: {
      kind: 'station_offline',
      subjectType: 'station',
      subjectId: r.station_id,
      triggerKey: `station_offline:${r.station_id}:${String(r.id)}`,
      stationId: r.station_id,
      siteId: r.site_id,
      primaryLanguage: language,
    },
  }));
}

async function faultedCandidates(
  language: string,
  on: boolean,
  marks: Marks,
): Promise<Candidate[]> {
  const window = await serialWindow('port_status_log', 'port_status_log');
  const rows =
    window != null && on
      ? await client<{ id: number; station_id: string; site_id: string | null }[]>`
          SELECT p.id, p.station_id, cs.site_id
          FROM port_status_log p
          JOIN charging_stations cs ON cs.id = p.station_id
          LEFT JOIN sites s ON s.id = cs.site_id
          WHERE p.id > ${window.last} AND p.id <= ${window.upper} AND p.new_status = 'faulted'
            AND (s.id IS NULL OR s.ai_insights_enabled)
          AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
          AND ${client.unsafe(operatorStationSql('cs'))}
          ORDER BY p.id
        `
      : [];
  if (window != null) {
    const upper = window.upper;
    marks.push(() =>
      writeScanWatermark('port_status_log', { lastId: upper, lastAt: null, lastKey: null }),
    );
  }
  const out: Candidate[] = rows.map((r) => ({
    incidentMember: true,
    insight: {
      kind: 'station_faulted',
      subjectType: 'station',
      subjectId: r.station_id,
      triggerKey: `station_faulted:${r.station_id}:${String(r.id)}`,
      stationId: r.station_id,
      siteId: r.site_id,
      primaryLanguage: language,
    },
  }));
  if (!on) return out;
  // A station that reports itself faulted (StatusNotification with no
  // connector, NotifyEvent AvailabilityState) writes no status log row.
  const reported = await client<{ id: string; site_id: string | null; bucket: string }[]>`
    SELECT cs.id, cs.site_id,
      to_char(date_trunc('hour', coalesce(cs.reported_status_at, cs.updated_at)) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24') AS bucket
    FROM charging_stations cs
    LEFT JOIN sites s ON s.id = cs.site_id
    WHERE cs.reported_status = 'faulted' AND (s.id IS NULL OR s.ai_insights_enabled)
          AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
          AND ${client.unsafe(operatorStationSql('cs'))}
      AND NOT EXISTS (
        SELECT 1 FROM ai_insights i
        WHERE i.station_id = cs.id AND i.kind = 'station_faulted'
          AND (i.status IN ('analyzing', 'open', 'pending') OR i.created_at > now() - interval '1 hour')
      )
    LIMIT 500
  `;
  for (const r of reported) {
    out.push({
      incidentMember: true,
      insight: {
        kind: 'station_faulted',
        subjectType: 'station',
        subjectId: r.id,
        triggerKey: `station_faulted:${r.id}:reported:${r.bucket}`,
        stationId: r.id,
        siteId: r.site_id,
        primaryLanguage: language,
      },
    });
  }
  return out;
}

async function alertCandidates(language: string, on: boolean, marks: Marks): Promise<Candidate[]> {
  const window = await serialWindow('event_alerts', 'event_alerts');
  if (window == null) return [];
  const rows = on
    ? await client<{ id: number; station_id: string; site_id: string | null }[]>`
        SELECT a.id, a.station_id, cs.site_id
        FROM event_alerts a
        JOIN charging_stations cs ON cs.id = a.station_id
        LEFT JOIN sites s ON s.id = cs.site_id
        WHERE a.id > ${window.last} AND a.id <= ${window.upper}
          AND (s.id IS NULL OR s.ai_insights_enabled)
          AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
          AND ${client.unsafe(operatorStationSql('cs'))}
        ORDER BY a.id
      `
    : [];
  marks.push(() =>
    writeScanWatermark('event_alerts', { lastId: window.upper, lastAt: null, lastKey: null }),
  );
  return rows.map((r) => ({
    incidentMember: false,
    insight: {
      kind: 'station_alert',
      subjectType: 'station',
      subjectId: r.station_id,
      triggerKey: `station_alert:${r.station_id}:${String(r.id)}`,
      stationId: r.station_id,
      siteId: r.site_id,
      primaryLanguage: language,
    },
  }));
}

async function authorizationCandidates(
  language: string,
  on: boolean,
  marks: Marks,
  secret: string,
): Promise<Candidate[]> {
  const window = await serialWindow('authorize_attempts', 'authorize_attempts');
  if (window == null) return [];
  // authorize_attempts.station_id is the OCPP identity the station presented.
  const rows = on
    ? await client<
        {
          id: number;
          id_token: string;
          created_at: Date | string;
          station_db_id: string;
          site_id: string | null;
        }[]
      >`
        SELECT a.id, a.id_token, a.created_at, cs.id AS station_db_id, cs.site_id
        FROM authorize_attempts a
        JOIN charging_stations cs ON cs.station_id = a.station_id
        LEFT JOIN sites s ON s.id = cs.site_id
        WHERE a.id > ${window.last} AND a.id <= ${window.upper} AND a.outcome <> 'accepted'
          AND (s.id IS NULL OR s.ai_insights_enabled)
          AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
          AND ${client.unsafe(operatorStationSql('cs'))}
        ORDER BY a.id
      `
    : [];
  marks.push(() =>
    writeScanWatermark('authorize_attempts', { lastId: window.upper, lastAt: null, lastKey: null }),
  );
  return rows.map((r) => {
    const subjectId = authorizationSubjectId(r.station_db_id, r.id_token, secret);
    return {
      incidentMember: false,
      insight: {
        kind: 'authorization_refused',
        subjectType: 'authorization',
        subjectId,
        triggerKey: `authorization_refused:${subjectId}:${hourBucket(new Date(r.created_at))}`,
        stationId: r.station_db_id,
        authorizeAttemptId: r.id,
        siteId: r.site_id,
        primaryLanguage: language,
      },
    };
  });
}

interface SessionRow {
  id: string;
  station_id: string;
  site_id: string | null;
  stopped_reason: string | null;
  updated_at: string;
}

async function sessionCandidates(
  language: string,
  on: boolean,
  marks: Marks,
): Promise<Candidate[]> {
  const mark = await readScanWatermark('charging_sessions');
  if (mark?.lastAt == null) {
    const [now] = await client<{ now: string }[]>`SELECT now()::text AS now`;
    await writeScanWatermark('charging_sessions', {
      lastId: null,
      lastAt: now?.now ?? null,
      lastKey: '',
    });
    return [];
  }
  const rows = await client<SessionRow[]>`
    SELECT s.id, s.station_id, cs.site_id, s.stopped_reason, s.updated_at::text AS updated_at
    FROM charging_sessions s
    JOIN charging_stations cs ON cs.id = s.station_id
    WHERE s.status IN ('failed', 'faulted')
      AND ${client.unsafe(operatorStationSql('cs'))}
      AND (s.updated_at, s.id) > (${mark.lastAt}::timestamptz, ${mark.lastKey ?? ''})
      AND s.updated_at <= now() - make_interval(secs => ${COMMIT_LAG_SECONDS})
    ORDER BY s.updated_at, s.id
    LIMIT ${SESSION_BATCH}
  `;
  const last = rows[rows.length - 1];
  if (last != null) {
    marks.push(() =>
      writeScanWatermark('charging_sessions', {
        lastId: null,
        lastAt: last.updated_at,
        lastKey: last.id,
      }),
    );
  }
  if (!on) return [];
  const enabledSites = await siteSwitches(rows.map((r) => r.site_id));
  const out: Candidate[] = [];
  for (const r of rows) {
    if (r.site_id != null && enabledSites.get(r.site_id) === false) continue;
    out.push({
      incidentMember: false,
      insight: {
        kind: 'session_failed',
        subjectType: 'session',
        subjectId: r.id,
        triggerKey: `session_failed:${r.id}`,
        stationId: r.station_id,
        sessionId: r.id,
        siteId: r.site_id,
        primaryLanguage: language,
      },
    });
  }
  return out;
}

interface ReservationAuditCandidateRow {
  id: number;
  action: ReservationInsightTriggerAction;
  after: unknown;
  reservation_id: string;
  station_id: string;
  site_id: string | null;
}

/**
 * Reservation trigger rows of `reservation_audit_log` (decision E16): one
 * insight per audit row (the trigger key is the row id). An `expired` row
 * raises a no-show only with reason `no_show`.
 */
async function reservationCandidates(
  language: string,
  on: boolean,
  marks: Marks,
): Promise<Candidate[]> {
  const window = await serialWindow('reservation_audit_log', 'reservation_audit_log');
  if (window == null) return [];
  const rows = on
    ? await client<ReservationAuditCandidateRow[]>`
        SELECT a.id, a.action::text AS action, a.after, r.id AS reservation_id, r.station_id,
          cs.site_id
        FROM reservation_audit_log a
        JOIN reservations r ON r.id = a.reservation_id
        JOIN charging_stations cs ON cs.id = r.station_id
        LEFT JOIN sites s ON s.id = cs.site_id
        WHERE a.id > ${window.last} AND a.id <= ${window.upper}
          AND a.action::text = ANY(${RESERVATION_TRIGGER_ACTIONS}::text[])
          AND (s.id IS NULL OR s.ai_insights_enabled)
          AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
          AND ${client.unsafe(operatorStationSql('cs'))}
        ORDER BY a.id
      `
    : [];
  marks.push(() =>
    writeScanWatermark('reservation_audit_log', {
      lastId: window.upper,
      lastAt: null,
      lastKey: null,
    }),
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    if (!reservationAuditRaisesInsight(r.action, reservationAuditReason(r.after))) continue;
    const kind = RESERVATION_INSIGHT_TRIGGERS[r.action];
    out.push({
      incidentMember: false,
      insight: {
        kind,
        subjectType: 'reservation',
        subjectId: r.reservation_id,
        triggerKey: `${kind}:${String(r.id)}`,
        stationId: r.station_id,
        reservationId: r.reservation_id,
        siteId: r.site_id,
        primaryLanguage: language,
      },
    });
  }
  return out;
}

/**
 * The first no-show insight at the same site in the last hour: a new one
 * groups under it (rule-only either way, decision E17).
 */
async function noShowGroupParent(insight: NewInsight): Promise<string | null> {
  if (insight.siteId == null || insight.reservationId == null) return null;
  const [row] = await client<{ id: string }[]>`
    SELECT id FROM ai_insights
    WHERE kind = 'reservation_no_show' AND site_id = ${insight.siteId}
      AND parent_insight_id IS NULL AND status IN ('analyzing', 'open', 'pending')
      AND reservation_id IS DISTINCT FROM ${insight.reservationId}
      AND created_at > now() - make_interval(mins => ${NO_SHOW_GROUP_MINUTES})
    ORDER BY created_at ASC, id ASC LIMIT 1
  `;
  return row?.id ?? null;
}

/**
 * The open site incident the station of a reservation fault belongs to: a
 * station insight of the same station is one of its members.
 */
async function stationIncidentParent(insight: NewInsight): Promise<string | null> {
  if (insight.stationId == null) return null;
  const [row] = await client<{ id: string }[]>`
    SELECT p.id FROM ai_insights m
    JOIN ai_insights p ON p.id = m.parent_insight_id
    WHERE m.station_id = ${insight.stationId} AND p.kind = 'site_incident'
      AND p.status IN ('analyzing', 'open', 'pending') AND p.site_id IS NOT DISTINCT FROM ${insight.siteId}
    ORDER BY p.created_at DESC LIMIT 1
  `;
  return row?.id ?? null;
}

async function siteSwitches(ids: readonly (string | null)[]): Promise<Map<string, boolean>> {
  const siteIds = [...new Set(ids.filter((id): id is string => id != null))];
  if (siteIds.length === 0) return new Map();
  const rows = await client<{ id: string; enabled: boolean }[]>`
    SELECT id, ai_insights_enabled AS enabled FROM sites WHERE id = ANY(${siteIds}::text[])
  `;
  return new Map(rows.map((r) => [r.id, r.enabled]));
}

/**
 * The first session insight at the same site with the same stop reason in
 * the last hour: a new one groups under it (no model call of its own).
 */
async function sessionGroupParent(insight: NewInsight): Promise<string | null> {
  if (insight.siteId == null || insight.sessionId == null) return null;
  const [row] = await client<{ id: string }[]>`
    SELECT i.id FROM ai_insights i
    JOIN charging_sessions s ON s.id = i.session_id
    JOIN charging_sessions mine ON mine.id = ${insight.sessionId}
    WHERE i.kind = 'session_failed' AND i.site_id = ${insight.siteId}
      AND i.parent_insight_id IS NULL AND i.status IN ('analyzing', 'open', 'pending')
      AND i.session_id <> ${insight.sessionId}
      AND s.stopped_reason IS NOT DISTINCT FROM mine.stopped_reason
      AND mine.stopped_reason IS NOT NULL
      AND i.created_at > now() - make_interval(mins => ${SESSION_GROUP_MINUTES})
    ORDER BY i.created_at ASC LIMIT 1
  `;
  return row?.id ?? null;
}

/**
 * Site incidents for the sites that got new offline or faulted station
 * insights: an open incident takes the new members; otherwise one is made
 * when enough stations of the site are analyzing inside the debounce window.
 */
async function groupIncidents(
  siteIds: readonly string[],
  settings: AiSettings,
  deps: AiInsightScanDeps,
  log: Logger,
): Promise<number> {
  let incidents = 0;
  const debounceMs = settings.insights.debounceSeconds * 1000;
  for (const siteId of siteIds) {
    const members = await client<{ id: string; station_id: string }[]>`
      SELECT id, station_id FROM ai_insights
      WHERE site_id = ${siteId} AND status = 'analyzing' AND parent_insight_id IS NULL
        AND kind IN ('station_offline', 'station_faulted')
        AND created_at > now() - make_interval(secs => ${Math.max(settings.insights.debounceSeconds, 60)})
    `;
    if (members.length === 0) continue;
    // A suppressed site raises no incident (its stations raise no member
    // either; this covers members created just before the suppression).
    if (await siteInsightsSuppressed(siteId)) continue;
    const [open] = await client<{ id: string }[]>`
      SELECT id FROM ai_insights
      WHERE site_id = ${siteId} AND kind = 'site_incident' AND status IN ('analyzing', 'open', 'pending')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (open != null) {
      await attachToIncident(
        members.map((m) => m.id),
        open.id,
      );
      continue;
    }
    const stations = new Set(members.map((m) => m.station_id));
    if (stations.size < settings.insights.siteIncidentThreshold) continue;
    const first = [...members].sort((a, b) => a.id.localeCompare(b.id))[0];
    const incidentId = await createInsight({
      kind: 'site_incident',
      subjectType: 'site',
      subjectId: siteId,
      triggerKey: `site_incident:${siteId}:${first?.id ?? ''}`,
      siteId,
      primaryLanguage: settings.insights.primaryLanguage,
    });
    if (incidentId == null) continue;
    await attachToIncident(
      members.map((m) => m.id),
      incidentId,
    );
    await enqueueOrWarn(deps, { kind: 'generate', insightId: incidentId }, debounceMs, log);
    incidents++;
  }
  return incidents;
}

/** Pending insights whose job is overdue: queued again under the same job id. */
async function requeueStuck(
  settings: AiSettings,
  deps: AiInsightScanDeps,
  log: Logger,
): Promise<number> {
  const minutes = Math.ceil(settings.insights.debounceSeconds / 60) + STUCK_MARGIN_MINUTES;
  const rows = await client<{ id: string }[]>`
    SELECT id FROM ai_insights
    WHERE status = 'analyzing' AND created_at < now() - make_interval(mins => ${minutes})
    ORDER BY created_at ASC LIMIT 200
  `;
  for (const r of rows) {
    await enqueueOrWarn(deps, { kind: 'generate', insightId: r.id }, 0, log);
  }
  // Translations whose request was lost (a failed publish or bridge enqueue).
  // The try stamp is the row's updated_at in epoch ms (floored like a JS Date),
  // so the job id matches the one the API queued for the same try.
  const texts = await client<{ insight_id: string; language: string; attempt: number }[]>`
    SELECT insight_id, language,
      floor(extract(epoch FROM updated_at) * 1000)::float8 AS attempt
    FROM ai_insight_texts
    WHERE status = 'pending' AND source = 'translated'
      AND updated_at < now() - make_interval(mins => ${STUCK_MARGIN_MINUTES})
    ORDER BY updated_at ASC LIMIT 200
  `;
  for (const t of texts) {
    await enqueueOrWarn(
      deps,
      { kind: 'translate', insightId: t.insight_id, language: t.language, attempt: t.attempt },
      0,
      log,
    );
  }
  return rows.length + texts.length;
}

/** Queues a job; a failure is logged and left to the next run's requeue (P9). */
async function enqueueOrWarn(
  deps: AiInsightScanDeps,
  data: AiInsightJobData,
  delayMs: number,
  log: Logger,
): Promise<void> {
  try {
    await deps.enqueue(data, delayMs);
  } catch (err) {
    log.warn({ err, insightId: data.insightId }, 'ai-insight-scan: enqueue failed, retried later');
  }
}

/**
 * Insights whose condition cleared end resolved: a station back online or no
 * longer faulted, recovered incidents, a station fault during a reservation
 * once the station recovered, a failed reservation fee captured later, a
 * stuck session that is no longer active (or whose offline advice no longer
 * applies), a token refusal whose cause is gone (the concurrent session
 * ended, the token usable again or created, or the same token accepted later
 * at the same station), and a station alert its station reported cleared.
 */
async function resolveCleared(deps: AiInsightScanDeps): Promise<number> {
  const cleared = await client<{ id: string }[]>`
    SELECT i.id FROM ai_insights i
    JOIN charging_stations cs ON cs.id = i.station_id
    WHERE i.status IN ('open', 'pending') AND (
      (i.kind = 'station_offline' AND cs.is_online)
      OR (i.kind = 'station_faulted' AND ${client.unsafe(stationAvailabilitySql('cs'))} <> 'faulted')
    )
    UNION ALL
    SELECT i.id FROM ai_insights i
    JOIN charging_stations cs ON cs.id = i.station_id
    WHERE i.status IN ('open', 'pending') AND i.kind = 'reservation_station_faulted' AND cs.is_online
      AND ${client.unsafe(stationAvailabilitySql('cs'))} <> 'faulted'
    UNION ALL
    SELECT i.id FROM ai_insights i
    WHERE i.status IN ('open', 'pending') AND i.kind = 'reservation_fee_failed'
      AND EXISTS (
        SELECT 1 FROM payment_records p
        WHERE p.reservation_id = i.reservation_id AND p.status = 'captured'
      )
    UNION ALL
    -- A stuck session no longer active, whatever ended it (an insight whose
    -- action waits is ended by the proposal sweep, which marks it stale);
    -- and the advice of a stuck session at an offline station (no action),
    -- once the station is back online or the session got an action insight
    -- (the CSMS end, or the stop once online).
    SELECT i.id FROM ai_insights i
    JOIN charging_sessions s ON s.id = i.session_id
    JOIN charging_stations cs ON cs.id = s.station_id
    WHERE i.status = 'open' AND i.kind = 'stuck_session'
      AND (
        s.status <> 'active'
        OR (
          NOT EXISTS (SELECT 1 FROM ai_proposals p WHERE p.insight_id = i.id)
          AND (
            cs.is_online
            OR EXISTS (
              SELECT 1 FROM ai_insights a
              JOIN ai_proposals p ON p.insight_id = a.id
              WHERE a.session_id = i.session_id AND a.kind = 'stuck_session' AND a.id <> i.id
            )
          )
        )
      )
    UNION ALL
    -- A token refusal whose cause is gone: the session a concurrent_tx refusal
    -- names ended; a blocked, expired or unknown token is usable again or was
    -- created after the refusal (the token or its driver changed since); or,
    -- for any outcome, the same token was accepted later at the same station.
    SELECT i.id FROM ai_insights i
    JOIN authorize_attempts a ON a.id = i.authorize_attempt_id
    WHERE i.status IN ('open', 'pending') AND i.kind = 'authorization_refused'
      AND (
        (a.outcome = 'concurrent_tx' AND NOT EXISTS (
          SELECT 1 FROM charging_sessions s
          WHERE s.id = substring(a.reason from '^concurrent_session ([^ ]+)$')
            AND s.status = 'active'
        ))
        OR (a.outcome IN ('blocked', 'expired', 'unknown') AND EXISTS (
          SELECT 1 FROM driver_tokens t
          LEFT JOIN drivers d ON d.id = t.driver_id
          WHERE t.id_token = a.id_token AND t.is_active AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
            AND (d.id IS NULL OR d.is_active)
            AND GREATEST(t.created_at, t.updated_at, COALESCE(d.updated_at, t.updated_at))
              > a.created_at
        ))
        OR EXISTS (
          SELECT 1 FROM authorize_attempts b
          WHERE b.station_id = a.station_id AND b.id_token = a.id_token
            AND b.outcome = 'accepted' AND b.id > a.id
        )
      )
    UNION ALL
    -- A station alert whose station later reported the same component and
    -- variable cleared (NotifyEvent eventData.cleared). The trigger key ends
    -- with the event_alerts id.
    SELECT i.id FROM ai_insights i
    JOIN event_alerts e
      ON e.id = substring(i.trigger_key from ':([0-9]+)$')::int AND e.station_id = i.station_id
    WHERE i.status IN ('open', 'pending') AND i.kind = 'station_alert'
      AND EXISTS (
        SELECT 1 FROM station_events se
        WHERE se.station_id = e.station_id AND se.created_at > e.created_at
          AND se.event_data @> jsonb_build_array(jsonb_build_object(
            'cleared', true,
            'component', jsonb_build_object('name', e.component),
            'variable', jsonb_build_object('name', e.variable)))
      )
    UNION ALL
    SELECT i.id FROM ai_insights i
    WHERE i.status IN ('open', 'pending') AND i.kind = 'site_incident'
      AND EXISTS (SELECT 1 FROM ai_insights m WHERE m.parent_insight_id = i.id)
      AND NOT EXISTS (
        SELECT 1 FROM ai_insights m
        JOIN charging_stations cs ON cs.id = m.station_id
        WHERE m.parent_insight_id = i.id
          AND (NOT cs.is_online OR ${client.unsafe(stationAvailabilitySql('cs'))} = 'faulted')
      )
    LIMIT 500
  `;
  const ids = await resolveInsights(cleared.map((r) => r.id));
  if (ids.length > 0) {
    const rows = await client<
      {
        id: string;
        site_id: string | null;
        station_id: string | null;
        session_id: string | null;
        kind: string;
      }[]
    >`SELECT id, site_id, station_id, session_id, kind FROM ai_insights WHERE id = ANY(${ids}::text[])`;
    for (const r of rows) {
      await publishInsightUpdated(deps.pubsub, {
        id: r.id,
        siteId: r.site_id,
        stationId: r.station_id,
        sessionId: r.session_id,
        kind: r.kind,
        status: 'resolved',
      });
    }
  }
  return ids.length;
}

function kindOn(kind: InsightKind, settings: AiSettings): boolean {
  if (isReservationInsightKind(kind)) return settings.insights.reservationEnabled;
  if (kind === 'session_failed') return settings.insights.sessionEnabled;
  if (kind === 'authorization_refused') return settings.insights.authorizationEnabled;
  return settings.insights.stationEnabled;
}

/**
 * One-off event insights still open after `aiInsights.expireAfterDays` end
 * `expired` (`INSIGHT_EXPIRE_KINDS`, and the authorization refusals with no
 * clearing condition, `AUTHORIZATION_EXPIRE_OUTCOMES`). Only `open`: an
 * insight whose action waits is never closed this way.
 */
async function expireAged(days: number, deps: AiInsightScanDeps): Promise<number> {
  const aged = await client<{ id: string }[]>`
    SELECT i.id FROM ai_insights i
    LEFT JOIN authorize_attempts a ON a.id = i.authorize_attempt_id
    WHERE i.status = 'open'
      AND i.created_at < now() - make_interval(days => ${days})
      AND (
        i.kind IN ${client([...INSIGHT_EXPIRE_KINDS])}
        OR (i.kind = 'authorization_refused'
          AND a.outcome::text IN ${client([...AUTHORIZATION_EXPIRE_OUTCOMES])})
      )
    LIMIT 500
  `;
  const ids = await expireInsights(aged.map((r) => r.id));
  if (ids.length > 0) {
    const rows = await client<
      {
        id: string;
        site_id: string | null;
        station_id: string | null;
        session_id: string | null;
        kind: string;
      }[]
    >`SELECT id, site_id, station_id, session_id, kind FROM ai_insights WHERE id = ANY(${ids}::text[])`;
    for (const r of rows) {
      await publishInsightUpdated(deps.pubsub, {
        id: r.id,
        siteId: r.site_id,
        stationId: r.station_id,
        sessionId: r.session_id,
        kind: r.kind,
        status: 'expired',
      });
    }
  }
  return ids.length;
}

export async function runAiInsightScan(
  deps: AiInsightScanDeps,
  log: Logger,
): Promise<AiInsightScanSummary> {
  const settings = await deps.getSettings();
  const enabled = settings.ops.enabled;
  const language = settings.insights.primaryLanguage;
  const on = (kind: InsightKind): boolean => enabled && kindOn(kind, settings);
  // Watermarks move even while a switch is off, so turning it on later does
  // not replay the backlog. They are written last, after every candidate is
  // stored (P4).
  const marks: Marks = [];
  const candidates = [
    ...(await offlineCandidates(language, on('station_offline'), marks)),
    ...(await faultedCandidates(language, on('station_faulted'), marks)),
    ...(await alertCandidates(language, on('station_alert'), marks)),
    ...(await authorizationCandidates(
      language,
      on('authorization_refused'),
      marks,
      deps.subjectSecret,
    )),
    ...(await sessionCandidates(language, on('session_failed'), marks)),
    ...(await reservationCandidates(language, on('reservation_rejected'), marks)),
  ];

  const debounceMs = settings.insights.debounceSeconds * 1000;
  const incidentSites = new Set<string>();
  const toQueue: string[] = [];
  let created = 0;
  for (const c of candidates) {
    let insight = c.insight;
    const parent =
      insight.kind === 'session_failed'
        ? await sessionGroupParent(insight)
        : insight.kind === 'reservation_no_show'
          ? await noShowGroupParent(insight)
          : insight.kind === 'reservation_station_faulted'
            ? await stationIncidentParent(insight)
            : null;
    if (parent != null) insight = { ...insight, parentInsightId: parent, status: 'superseded' };
    const id = await createInsight(insight);
    if (id == null) continue;
    created++;
    if (insight.status === 'superseded') continue;
    if (c.incidentMember && insight.siteId != null) incidentSites.add(insight.siteId);
    toQueue.push(id);
  }
  // Every candidate is stored: a lost enqueue is recovered by requeueStuck.
  for (const id of toQueue)
    await enqueueOrWarn(deps, { kind: 'generate', insightId: id }, debounceMs, log);
  for (const mark of marks) await mark();

  const incidents = enabled ? await groupIncidents([...incidentSites], settings, deps, log) : 0;
  const requeued = enabled ? await requeueStuck(settings, deps, log) : 0;
  const resolved = await resolveCleared(deps);
  const expired = await expireAged(settings.insights.expireAfterDays, deps);
  const summary = { created, incidents, requeued, resolved, expired };
  if (created + incidents + requeued + resolved > 0) {
    log.info(summary, 'ai-insight-scan: completed');
  }
  return summary;
}

/** Cron entry: the scan with the worker's queue and pub/sub. */
export async function aiInsightScanHandler(log: Logger): Promise<void> {
  await runAiInsightScan(
    {
      // Reservation triggers only while reservations are on (getInsightAiSettings).
      getSettings: getInsightAiSettings,
      enqueue: enqueueAiInsightJob,
      pubsub: getPubSub(),
      subjectSecret: config.SETTINGS_ENCRYPTION_KEY,
    },
    log,
  );
}
