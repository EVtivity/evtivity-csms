// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  chargingStations,
  connectionLogs,
  db,
  getStationSimMatch,
  getSystemTimezone,
  settings,
  simAlerts,
  simSessions,
  sites,
  stationEvents,
  users,
  variableMonitoringRules,
  type StationSimMatch,
} from '@evtivity/database';
import { normalizeIccid, SIM_RANGE_MAX_DAYS, SIM_REFRESH_DAY_OPTIONS } from '@evtivity/lib';
import {
  clearStationSim,
  confirmStationSim,
  refreshStationSimProvider,
  SIM_KEYS,
  simHistoryDays,
  simRefOf,
  simRefreshPeriod,
  SimProviderError,
  SimRefreshValidationError,
  readStationDataLink,
  stationCoveredDays,
  stationDisconnectCauses,
  confirmedSimRef,
  stationSignalSnapshot,
  type SimProvider,
  type SimProviderId,
} from '@evtivity/services/station-sim.service';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse, successResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { checkStationSiteAccess, requireAllSiteAccess } from '../lib/site-access.js';
import { recordStationCommandAudit } from '../lib/station-command-audit.js';
import { isSimFeatureOn, readSimSettings, simProviderRegistry } from '../lib/sim.js';
import { simKeyStore } from '../lib/sim-keys.js';
import { sendSimProviderError } from './sim-provider-settings.js';
import type { JwtPayload } from '../plugins/auth.js';

const DAY_MS = 86_400_000;
/** Refreshes per station a minute, across API pods. */
export const SIM_REFRESH_LIMIT_PER_MINUTE = 6;
/** One network reset per station a minute, across API pods. */
export const SIM_RESET_COOLDOWN_SECONDS = 60;
const TIMELINE_DEFAULT_LIMIT = 200;
/** SIM alerts the status shows; the timeline lists them all. */
const RECENT_ALERTS = 5;
const CONNECTION_LOG_RETENTION_KEY = 'logs.connection.retentionDays';
const CONNECTION_LOG_RETENTION_DEFAULT = 90;

const STATION_NOT_FOUND = { error: 'Station not found', code: 'STATION_NOT_FOUND' } as const;

const stationParams = z.object({ id: ID_PARAMS.stationId.describe('Station ID') });

const capabilitiesSchema = z
  .object({
    networkName: z.boolean(),
    radioAccessTechnology: z.boolean(),
    cellId: z.boolean(),
    usage: z.boolean(),
    sessions: z.boolean(),
    alerts: z.boolean(),
    networkReset: z.boolean(),
  })
  .passthrough()
  .describe('What the provider reports');

const storedStatusSchema = z
  .object({
    state: z
      .string()
      .describe('active, pending, suspended, inactive, deactivated, test or unknown'),
    providerState: z.string().describe("The provider's own state name"),
    inSession: z.boolean().nullable().describe('A data session was open at the fetch'),
    openSessionBeganAt: z.string().nullable().describe('Begin of the open data session'),
    apn: z.string().nullable(),
    profileName: z.string().nullable(),
    lastSessionAt: z.string().nullable(),
    usage: z
      .object({
        bytes: z.number(),
        periodEnd: z.string().nullable(),
        limitBytes: z.number().nullable(),
      })
      .passthrough()
      .nullable()
      .describe('Data used this billing period'),
  })
  .passthrough();

const signalReadingSchema = z
  .object({
    value: z.number().describe('The value as the station reported it'),
    unit: z.enum(['dBm', 'ASU']),
    inferred: z.boolean().describe('The station reported no unit; it came from the range'),
    dbm: z.number().nullable().describe('The value in dBm, null for an unknown ASU 99'),
    grade: z
      .enum(['good', 'fair', 'poor', 'unknown'])
      .describe('From sim.signal.goodDbm and sim.signal.fairDbm (RSSI thresholds)'),
  })
  .passthrough();

const stationSignalSchema = z
  .object({
    protocol: z.enum(['ocpp2x', 'ocpp1.6']),
    deviceModel: z
      .enum(['unread', 'no_datalink', 'ok'])
      .nullable()
      .describe(
        'OCPP 2.x: unread before the station reported its device model, no_datalink when it reports no DataLink; null for 1.6',
      ),
    readAt: z.string().nullable().describe('When the station last reported these values'),
    values: z
      .record(z.string().nullable())
      .describe('Every stored value by name: DataLink[instance].Variable, or the 1.6 key'),
    dataLinks: z
      .array(
        z
          .object({
            instance: z.string().nullable().describe('The DataLink component instance'),
            values: z.record(z.string().nullable()),
            signalUnit: z.string().nullable(),
            signal: signalReadingSchema.nullable(),
          })
          .passthrough(),
      )
      .describe('One entry per DataLink instance (OCPP 2.x)'),
    activeNetworkProfile: z.string().nullable(),
    thresholds: z.object({ goodDbm: z.number(), fairDbm: z.number() }).passthrough(),
  })
  .passthrough();

const simStatusResponse = z
  .object({
    provider: z.string().nullable().describe('The SIM provider, null when no SIM data is shown'),
    reason: z
      .enum([
        'no_iccid',
        'no_provider_configured',
        'not_looked_up',
        'not_found',
        'sim_matched_elsewhere',
      ])
      .nullable()
      .describe('Why there is no provider, null when there is one'),
    capabilities: capabilitiesSchema.nullable(),
    status: storedStatusSchema.nullable().describe('The status stored by the last Refresh'),
    statusFetchedAt: z.string().nullable().describe('When the status was fetched'),
    network: z
      .object({
        name: z.string().nullable(),
        radioAccessTechnology: z.string().nullable(),
        cellId: z.string().nullable(),
        observedAt: z.string().describe('End of the newest stored session'),
      })
      .passthrough()
      .nullable()
      .describe('Network of the newest stored session'),
    match: z
      .object({
        confirmed: z
          .boolean()
          .describe(
            'A person with access to every site confirmed the SIM. Until then nothing is fetched from the provider and no reset is possible',
          ),
        confirmedAt: z.string().nullable(),
        matchedAt: z
          .string()
          .nullable()
          .describe('When the SIM was matched; Confirm SIM sends it back'),
        iccidSource: z
          .enum(['station', 'entered'])
          .describe('Where the ICCID of the match came from: reported by the station, or entered'),
        enteredBy: z
          .object({
            id: z.string(),
            name: z.string().nullable().describe('First and last name, null when not set'),
          })
          .passthrough()
          .nullable()
          .describe('The person who entered the ICCID, for an entered one'),
      })
      .passthrough()
      .nullable(),
    lastFetchedAt: z.string().nullable().describe('When the sessions were last fetched'),
    recentAlerts: z
      .array(
        z
          .object({
            kind: z
              .string()
              .describe(
                'data_limit, data_warning, device_changed, device_model_changed or first_device',
              ),
            receivedAt: z.string().describe('When the provider logged the alert'),
          })
          .passthrough(),
      )
      .describe('The five newest stored SIM alerts; alerts arrive only with a Refresh'),
    station: stationSignalSchema
      .nullable()
      .describe('Signal values read from the station, null while station signal reads are off'),
    historyDays: z.number().nullable().describe('How far back the provider keeps data'),
    reportingDelayHours: z.number().nullable().describe('How late the provider reports sessions'),
    fetchDays: z.number().describe('The Refresh period preselected'),
    retentionDays: z.number().describe('Days fetched SIM data is kept'),
    coverageTimeZone: z
      .string()
      .describe('The time zone of the coverage days: the site, else the system time zone'),
  })
  .passthrough();

const timelineQuery = z.object({
  from: z.string().datetime({ offset: true }).optional().describe('Start, default 24 hours ago'),
  to: z.string().datetime({ offset: true }).optional().describe('End, default and at most now'),
  limit: z.coerce.number().int().min(1).max(500).optional().describe('Items per page, default 200'),
  cursor: z.string().max(200).optional().describe('nextCursor of the previous page'),
});

const timelineItem = z
  .object({
    at: z.string().describe('When it happened'),
    source: z.enum(['ocpp', 'sim']).describe('ocpp: the station connection; sim: the provider'),
    kind: z
      .string()
      .describe(
        'connected, disconnected, signal_low, signal_restored (the low signal monitor), session, or an alert kind',
      ),
    details: z
      .record(z.unknown())
      .describe(
        'Fields of the item. A disconnect carries offlineCause: server, sim_account, station, network, pending or unknown, computed from stored data',
      ),
  })
  .passthrough();

const timelineResponse = z
  .object({
    items: z.array(timelineItem),
    nextCursor: z.string().nullable(),
    from: z.string().describe('Start of the range read'),
    to: z.string().describe('End of the range read'),
    capped: z.boolean().describe('The range was shortened to 31 days or the retention'),
    lastFetchedAt: z.string().nullable(),
    days: z
      .array(
        z
          .object({
            date: z.string(),
            label: z.enum([
              'has_data',
              'no_sessions',
              'partial',
              'pending',
              'not_fetched',
              'unavailable',
            ]),
          })
          .passthrough(),
      )
      .describe('What the stored SIM data of each day can show, in the station time zone'),
  })
  .passthrough();

const refreshBody = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(SIM_RANGE_MAX_DAYS)
    .optional()
    .describe('Days to fetch back from now: 1, 3, 7, 14 or 31; default sim.sessions.fetchDays'),
  from: z.string().datetime({ offset: true }).optional().describe('Start of a date range'),
  to: z.string().datetime({ offset: true }).optional().describe('End of a date range'),
  retryLookup: z
    .boolean()
    .optional()
    .describe('Look the SIM up again although the last lookup found none within the hour'),
});

const providerPartSchema = z
  .object({
    result: z.enum(['ok', 'skipped', 'failed']),
    reason: z
      .string()
      .optional()
      .describe(
        'provider_off, not_matched (see matchReason), not_confirmed (nothing is fetched until Confirm SIM), backoff or in_progress for a skipped part',
      ),
    matchReason: z.string().optional(),
    kind: z.string().optional().describe('The error kind of a failed part'),
    provider: z.string().optional(),
    fetchedAt: z.string().optional(),
    sessionsStored: z.number().optional(),
    alertsStored: z.number().optional(),
    retryAfter: z.number().optional(),
  })
  .passthrough();

const refreshResponse = z
  .object({
    provider: providerPartSchema.describe('The SIM provider part'),
    station: z
      .object({
        result: z.enum(['ok', 'skipped', 'failed']),
        reason: z
          .string()
          .optional()
          .describe(
            'signal_off, station_offline, recent, no_device_model, no_keys or not_operator_station (a conformance test station) for a skipped part',
          ),
        kind: z
          .string()
          .optional()
          .describe('timeout, command_failed, unsupported or unavailable for a failed part'),
        readAt: z.string().optional(),
      })
      .passthrough()
      .describe('The station signal part'),
  })
  .passthrough();

const resetResponse = z
  .object({ status: z.literal('accepted').describe('The provider accepted the network reset') })
  .passthrough();

const confirmResponse = z
  .object({ confirmed: z.literal(true), confirmedAt: z.string().nullable() })
  .passthrough();

const confirmBody = z.object({
  matchedAt: z
    .string()
    .datetime({ offset: true })
    .describe(
      'The matchedAt of the match the confirmation showed (GET /v1/stations/{id}/sim). A match that changed since answers 409 SIM_MATCH_CHANGED.',
    ),
});

async function sendFeatureDisabled(reply: FastifyReply): Promise<void> {
  await reply.status(400).send({
    error: 'SIM providers and station signal reads are turned off',
    code: 'SIM_FEATURE_DISABLED',
  });
}

async function sendNotConfigured(reply: FastifyReply): Promise<void> {
  await reply.status(400).send({
    error: 'No SIM provider is configured',
    code: 'SIM_PROVIDER_NOT_CONFIGURED',
  });
}

async function stationAccessible(request: FastifyRequest, stationId: string): Promise<boolean> {
  const { userId } = request.user as JwtPayload;
  return checkStationSiteAccess(stationId, userId);
}

async function stationRow(
  stationId: string,
): Promise<{ iccid: string | null; timezone: string | null } | null> {
  const [row] = await db
    .select({ iccid: chargingStations.iccid, timezone: sites.timezone })
    .from(chargingStations)
    .leftJoin(sites, eq(sites.id, chargingStations.siteId))
    .where(eq(chargingStations.id, stationId));
  return row ?? null;
}

/** The time zone the coverage days are counted in: the site's, else the system's. */
async function coverageTimeZone(station: { timezone: string | null }): Promise<string> {
  return station.timezone ?? (await getSystemTimezone());
}

/** The match as the status shows it, with where its ICCID came from. */
async function matchView(
  match: StationSimMatch,
  stationIccid: string | null,
): Promise<{
  confirmed: boolean;
  confirmedAt: string | null;
  matchedAt: string | null;
  iccidSource: 'station' | 'entered';
  enteredBy: { id: string; name: string | null } | null;
}> {
  const entered = match.enteredIccid != null && match.enteredIccid === normalizeIccid(stationIccid);
  let enteredBy: { id: string; name: string | null } | null = null;
  if (entered && match.enteredBy != null) {
    const [user] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, match.enteredBy));
    const name = [user?.firstName, user?.lastName]
      .filter((part): part is string => part != null && part.trim() !== '')
      .join(' ');
    enteredBy = { id: match.enteredBy, name: name === '' ? null : name };
  }
  return {
    confirmed: match.confirmedAt != null,
    confirmedAt: match.confirmedAt?.toISOString() ?? null,
    matchedAt: match.matchedAt?.toISOString() ?? null,
    iccidSource: entered ? 'entered' : 'station',
    enteredBy,
  };
}

/** Seconds a Redis key still lives, else the fallback; a Redis failure is logged. */
async function secondsLeft(
  keys: ReturnType<typeof simKeyStore>,
  key: string,
  fallback: number,
  request: FastifyRequest,
  stationId: string,
): Promise<number> {
  try {
    return (await keys.ttlSeconds(key)) ?? fallback;
  } catch (err: unknown) {
    request.log.warn(
      { err, stationId },
      'SIM limit wait not read in Redis; the full wait is given',
    );
    return fallback;
  }
}

async function connectionLogRetentionDays(): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, CONNECTION_LOG_RETENTION_KEY));
  const days = row?.value;
  return typeof days === 'number' && days > 0 ? days : CONNECTION_LOG_RETENTION_DEFAULT;
}

/** The enabled provider with this id, or null. */
async function providerOf(id: string | null): Promise<SimProvider | null> {
  if (id == null) return null;
  return simProviderRegistry().getProvider(id as SimProviderId);
}

/** The timeline sources; at one time their items sort by source, then by row id, newest first. */
type TimelineSource = 'sim:session' | 'sim:alert' | 'ocpp:event' | 'ocpp';
const SOURCE_RANK: Record<TimelineSource, number> = {
  'sim:session': 3,
  'sim:alert': 2,
  'ocpp:event': 1,
  ocpp: 0,
};

/** NotifyEvent rows that hold a DataLink.SignalStrength item a monitor triggered. */
const SIGNAL_EVENT_MATCH = JSON.stringify([
  { component: { name: 'DataLink' }, variable: { name: 'SignalStrength' }, trigger: 'Alerting' },
]);

/**
 * The low signal items of a NotifyEvent row: a DataLink.SignalStrength item the
 * monitor triggered (trigger Alerting, cleared or not), every one of the row.
 * An item that names its monitor must name a low signal monitor of the station.
 */
function signalEventItems(
  eventData: unknown,
  lowSignalMonitorIds: ReadonlySet<number>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(eventData)) return [];
  return (eventData as Array<Record<string, unknown>>).filter((raw) => {
    const component = raw.component as { name?: unknown } | undefined;
    const variable = raw.variable as { name?: unknown } | undefined;
    if (component?.name !== 'DataLink' || variable?.name !== 'SignalStrength') return false;
    if (raw.trigger !== 'Alerting') return false;
    const monitorId = raw.variableMonitoringId;
    return typeof monitorId !== 'number' || lowSignalMonitorIds.has(monitorId);
  });
}

interface TimelineEntry {
  at: Date;
  from: TimelineSource;
  id: number;
  source: 'ocpp' | 'sim';
  kind: string;
  details: Record<string, unknown>;
}

interface TimelineCursor {
  at: Date;
  from: TimelineSource;
  id: number;
}

/** The last row a source returned when it returned more than `limit`, else null. */
function horizonOf<Row extends { id: number }>(
  from: TimelineSource,
  rows: readonly Row[],
  limit: number,
  atOf: (row: Row) => Date,
): TimelineCursor | null {
  if (rows.length <= limit) return null;
  const last = rows[rows.length - 1];
  return last == null ? null : { at: atOf(last), from, id: last.id };
}

function cursorOf(entry: TimelineCursor): string {
  return Buffer.from(`${entry.at.toISOString()}|${entry.from}|${String(entry.id)}`).toString(
    'base64url',
  );
}

function parseCursor(cursor: string | undefined): TimelineCursor | null {
  if (cursor == null) return null;
  const [iso, from, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (iso == null || from == null || id == null || !Object.hasOwn(SOURCE_RANK, from)) return null;
  const at = new Date(iso);
  const rowId = Number(id);
  if (Number.isNaN(at.getTime()) || !Number.isSafeInteger(rowId)) return null;
  return { at, from: from as TimelineSource, id: rowId };
}

/** Newest first: time, then source, then row id. */
function compareEntries(a: TimelineCursor, b: TimelineCursor): number {
  return (
    b.at.getTime() - a.at.getTime() || SOURCE_RANK[b.from] - SOURCE_RANK[a.from] || b.id - a.id
  );
}

/** Times compared at the millisecond the cursor carries, so a tie is a tie. */
function msOf(column: AnyColumn): SQL {
  return sql`date_trunc('milliseconds', ${column})`;
}

/** The rows of one source that come after the cursor in the timeline order. */
function afterCursor(
  from: TimelineSource,
  atColumn: AnyColumn,
  idColumn: AnyColumn,
  cursor: TimelineCursor | null,
): SQL | undefined {
  if (cursor == null) return undefined;
  const at = msOf(atColumn);
  const rank = SOURCE_RANK[from] - SOURCE_RANK[cursor.from];
  const sameTime =
    rank < 0
      ? sql`${at} = ${cursor.at}`
      : rank === 0
        ? and(sql`${at} = ${cursor.at}`, lt(idColumn, cursor.id))
        : undefined;
  return sameTime == null ? sql`${at} < ${cursor.at}` : or(sql`${at} < ${cursor.at}`, sameTime);
}

export function stationSimRoutes(app: FastifyInstance): void {
  app.get(
    '/stations/:id/sim',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: "Get a station's SIM",
        description:
          'The SIM status, match and network stored by the last Refresh. Reads the database only: no provider call and no OCPP command.',
        operationId: 'getStationSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(simStatusResponse),
          400: errorWith('SIM features off', [ERROR_CODES.SIM_FEATURE_DISABLED]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      if (!(await stationAccessible(request, id))) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const simSettings = await readSimSettings();
      if (!isSimFeatureOn(simSettings)) {
        await sendFeatureDisabled(reply);
        return;
      }
      const [station, match] = await Promise.all([stationRow(id), getStationSimMatch(id)]);
      if (station == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const registry = simProviderRegistry();
      const enabled = await registry.enabledProviders();
      const provider = match?.provider != null ? await providerOf(match.provider) : null;
      const common = {
        historyDays: provider?.historyDays ?? (await simHistoryDays(registry)),
        reportingDelayHours: provider?.reportingDelayHours ?? null,
        fetchDays: simSettings.fetchDays,
        retentionDays: simSettings.retentionDays,
        coverageTimeZone: await coverageTimeZone(station),
        station: simSettings.stationSignalEnabled
          ? await stationSignalSnapshot(id, simSettings)
          : null,
      };
      if (provider == null || match == null || simRefOf(match) == null) {
        let reason:
          | 'no_iccid'
          | 'no_provider_configured'
          | 'not_looked_up'
          | 'not_found'
          | 'sim_matched_elsewhere';
        if (enabled.length === 0 || match?.provider != null) reason = 'no_provider_configured';
        else if (normalizeIccid(station.iccid) == null) reason = 'no_iccid';
        else if (match?.lookupMissReason === 'sim_matched_elsewhere')
          reason = 'sim_matched_elsewhere';
        else if (match?.lookupMissReason === 'not_found') reason = 'not_found';
        else reason = 'not_looked_up';
        return {
          provider: null,
          reason,
          capabilities: null,
          status: null,
          statusFetchedAt: null,
          network: null,
          match: null,
          lastFetchedAt: null,
          recentAlerts: [],
          ...common,
        };
      }
      const view = await matchView(match, station.iccid);
      // An unconfirmed match fetched nothing and shows nothing of the SIM.
      const sim = confirmedSimRef(match);
      if (sim == null) {
        return {
          provider: provider.id,
          reason: null,
          capabilities: provider.capabilities,
          status: null,
          statusFetchedAt: null,
          network: null,
          match: view,
          lastFetchedAt: null,
          recentAlerts: [],
          ...common,
        };
      }
      const [[newest], recentAlerts] = await Promise.all([
        db
          .select({
            networkName: simSessions.networkName,
            radioAccessTechnology: simSessions.radioAccessTechnology,
            cellId: simSessions.cellId,
            endedAt: simSessions.endedAt,
          })
          .from(simSessions)
          .where(
            and(
              eq(simSessions.stationId, id),
              eq(simSessions.provider, provider.id),
              eq(simSessions.providerSimId, sim.providerRef),
            ),
          )
          .orderBy(desc(simSessions.endedAt), desc(simSessions.id))
          .limit(1),
        db
          .select({ kind: simAlerts.kind, receivedAt: simAlerts.receivedAt })
          .from(simAlerts)
          .where(
            and(
              eq(simAlerts.stationId, id),
              eq(simAlerts.provider, provider.id),
              eq(simAlerts.providerRef, sim.providerRef),
            ),
          )
          .orderBy(desc(simAlerts.receivedAt), desc(simAlerts.id))
          .limit(RECENT_ALERTS),
      ]);
      return {
        provider: provider.id,
        reason: null,
        capabilities: provider.capabilities,
        status: match.lastStatus ?? null,
        statusFetchedAt: match.statusFetchedAt?.toISOString() ?? null,
        network:
          newest == null
            ? null
            : {
                name: newest.networkName,
                radioAccessTechnology: newest.radioAccessTechnology,
                cellId: newest.cellId,
                observedAt: newest.endedAt.toISOString(),
              },
        match: view,
        lastFetchedAt: match.sessionsSyncedAt?.toISOString() ?? null,
        recentAlerts: recentAlerts.map((a) => ({
          kind: a.kind,
          receivedAt: a.receivedAt.toISOString(),
        })),
        ...common,
      };
    },
  );

  app.get(
    '/stations/:id/sim/timeline',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: "Get a station's connectivity timeline",
        description:
          'The stored SIM sessions and alerts and the OCPP connects and disconnects of the station in one list, newest first, plus what each day of the range has stored. Reads the database only. The range is at most 31 days and within the SIM and connection log retentions; a longer one is shortened (capped).',
        operationId: 'getStationSimTimeline',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(timelineQuery),
        response: {
          200: itemResponse(timelineResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const query = request.query as z.infer<typeof timelineQuery>;
      if (!(await stationAccessible(request, id))) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const simSettings = await readSimSettings();
      if (!isSimFeatureOn(simSettings)) {
        await sendFeatureDisabled(reply);
        return;
      }
      const station = await stationRow(id);
      if (station == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const now = new Date();
      const to = new Date(
        Math.min(query.to != null ? Date.parse(query.to) : now.getTime(), now.getTime()),
      );
      const from = query.from != null ? new Date(query.from) : new Date(to.getTime() - DAY_MS);
      if (from.getTime() >= to.getTime()) {
        await reply.status(400).send({
          error: 'The timeline start must be before its end',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const cursor = parseCursor(query.cursor);
      if (query.cursor != null && cursor == null) {
        await reply
          .status(400)
          .send({ error: 'The cursor is not valid', code: 'VALIDATION_ERROR' });
        return;
      }
      const keptDays = Math.min(simSettings.retentionDays, await connectionLogRetentionDays());
      const earliest = Math.max(
        to.getTime() - SIM_RANGE_MAX_DAYS * DAY_MS,
        now.getTime() - keptDays * DAY_MS,
      );
      const capped = from.getTime() < earliest;
      const rangeFrom = capped ? new Date(earliest) : from;
      if (rangeFrom.getTime() >= to.getTime()) {
        await reply.status(400).send({
          error: 'The timeline end is older than the kept SIM and connection data',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const limit = query.limit ?? TIMELINE_DEFAULT_LIMIT;
      // Only the rows of the confirmed SIM: data of an earlier SIM of the station never shows.
      const match = await getStationSimMatch(id);
      const sim = confirmedSimRef(match);

      const [sessionRows, alertRows, connectionRows, signalRows, monitorRows] = await Promise.all([
        // A session that began before the range but ended in it belongs to the range.
        sim == null
          ? []
          : db
              .select()
              .from(simSessions)
              .where(
                and(
                  eq(simSessions.stationId, id),
                  eq(simSessions.provider, sim.provider),
                  eq(simSessions.providerSimId, sim.providerRef),
                  gte(simSessions.endedAt, rangeFrom),
                  lte(simSessions.startedAt, to),
                  afterCursor('sim:session', simSessions.startedAt, simSessions.id, cursor),
                ),
              )
              .orderBy(desc(msOf(simSessions.startedAt)), desc(simSessions.id))
              .limit(limit + 1),
        sim == null
          ? []
          : db
              .select()
              .from(simAlerts)
              .where(
                and(
                  eq(simAlerts.stationId, id),
                  eq(simAlerts.provider, sim.provider),
                  eq(simAlerts.providerRef, sim.providerRef),
                  gte(simAlerts.receivedAt, rangeFrom),
                  lte(simAlerts.receivedAt, to),
                  afterCursor('sim:alert', simAlerts.receivedAt, simAlerts.id, cursor),
                ),
              )
              .orderBy(desc(msOf(simAlerts.receivedAt)), desc(simAlerts.id))
              .limit(limit + 1),
        db
          .select({
            id: connectionLogs.id,
            event: connectionLogs.event,
            metadata: connectionLogs.metadata,
            createdAt: connectionLogs.createdAt,
          })
          .from(connectionLogs)
          .where(
            and(
              eq(connectionLogs.stationId, id),
              inArray(connectionLogs.event, ['connected', 'disconnected']),
              gte(connectionLogs.createdAt, rangeFrom),
              lte(connectionLogs.createdAt, to),
              afterCursor('ocpp', connectionLogs.createdAt, connectionLogs.id, cursor),
            ),
          )
          .orderBy(desc(msOf(connectionLogs.createdAt)), desc(connectionLogs.id))
          .limit(limit + 1),
        db
          .select({
            id: stationEvents.id,
            generatedAt: stationEvents.generatedAt,
            eventData: stationEvents.eventData,
          })
          .from(stationEvents)
          .where(
            and(
              eq(stationEvents.stationId, id),
              gte(stationEvents.generatedAt, rangeFrom),
              lte(stationEvents.generatedAt, to),
              sql`${stationEvents.eventData} @> ${SIGNAL_EVENT_MATCH}::jsonb`,
              afterCursor('ocpp:event', stationEvents.generatedAt, stationEvents.id, cursor),
            ),
          )
          .orderBy(desc(msOf(stationEvents.generatedAt)), desc(stationEvents.id))
          .limit(limit + 1),
        db
          .select({ monitoringId: variableMonitoringRules.monitoringId })
          .from(variableMonitoringRules)
          .where(
            and(
              eq(variableMonitoringRules.stationId, id),
              eq(variableMonitoringRules.source, 'low_signal'),
            ),
          ),
      ]);
      const lowSignalMonitorIds = new Set(
        monitorRows.flatMap((row) => (row.monitoringId != null ? [row.monitoringId] : [])),
      );

      const entries: TimelineEntry[] = [
        ...sessionRows.map((s) => ({
          at: s.startedAt,
          from: 'sim:session' as const,
          id: s.id,
          source: 'sim' as const,
          kind: 'session',
          details: {
            provider: s.provider,
            endedAt: s.endedAt.toISOString(),
            bytes: s.bytes,
            networkName: s.networkName,
            radioAccessTechnology: s.radioAccessTechnology,
            cellId: s.cellId,
            apn: s.apn,
          },
        })),
        ...alertRows.map((a) => ({
          at: a.receivedAt,
          from: 'sim:alert' as const,
          id: a.id,
          source: 'sim' as const,
          kind: a.kind,
          details: { provider: a.provider },
        })),
        ...signalRows.flatMap((e) =>
          signalEventItems(e.eventData, lowSignalMonitorIds).map((item) => {
            const component = item.component as { instance?: unknown };
            return {
              at: e.generatedAt,
              from: 'ocpp:event' as const,
              id: e.id,
              source: 'ocpp' as const,
              kind: item.cleared === true ? 'signal_restored' : 'signal_low',
              details: {
                instance: typeof component.instance === 'string' ? component.instance : null,
                actualValue: typeof item.actualValue === 'string' ? item.actualValue : null,
              },
            };
          }),
        ),
        ...connectionRows.map((c) => {
          const reason = (c.metadata as { reason?: unknown } | null)?.reason;
          return {
            at: c.createdAt,
            from: 'ocpp' as const,
            id: c.id,
            source: 'ocpp' as const,
            kind: c.event,
            details: typeof reason === 'string' ? { reason } : {},
          };
        }),
      ].sort(compareEntries);

      // A source that returned more than `limit` rows may hold more rows after its
      // last one; items past the first such row could hide those, so the page
      // stops there. A NotifyEvent row can give no item, so this uses row counts.
      const horizons: TimelineCursor[] = [
        horizonOf('sim:session', sessionRows, limit, (r) => r.startedAt),
        horizonOf('sim:alert', alertRows, limit, (r) => r.receivedAt),
        horizonOf('ocpp:event', signalRows, limit, (r) => r.generatedAt),
        horizonOf('ocpp', connectionRows, limit, (r) => r.createdAt),
      ].flatMap((h) => (h != null ? [h] : []));
      const horizon = horizons.sort(compareEntries)[0] ?? null;
      const known =
        horizon == null ? entries : entries.filter((entry) => compareEntries(entry, horizon) <= 0);

      // The cursor names a row, so the items of the page's last row all stay on it.
      let pageSize = Math.min(limit, known.length);
      const lastKept = known[pageSize - 1];
      while (
        lastKept != null &&
        pageSize < known.length &&
        known[pageSize]?.from === lastKept.from &&
        known[pageSize]?.id === lastKept.id
      ) {
        pageSize += 1;
      }
      const page = known.slice(0, pageSize);
      const last = page[page.length - 1];
      const nextCursor =
        known.length > page.length && last != null
          ? cursorOf(last)
          : horizon != null
            ? cursorOf(horizon)
            : null;
      const provider = await providerOf(match?.provider ?? null);
      // The likely cause of each disconnect, from stored data only (no provider call).
      const disconnects = page.filter((entry) => entry.kind === 'disconnected');
      const causes = await stationDisconnectCauses(
        id,
        disconnects.map((entry) => ({
          at: entry.at,
          reason: typeof entry.details.reason === 'string' ? entry.details.reason : null,
        })),
        { reportingDelayHours: provider?.reportingDelayHours ?? 0, now },
      );
      disconnects.forEach((entry, index) => {
        entry.details.offlineCause = causes[index] ?? 'unknown';
      });
      const days = await stationCoveredDays(
        id,
        sim,
        rangeFrom,
        to,
        await coverageTimeZone(station),
        {
          historyDays: provider?.historyDays ?? (await simHistoryDays(simProviderRegistry())),
          retentionDays: simSettings.retentionDays,
          reportingDelayHours: provider?.reportingDelayHours ?? 0,
        },
        now,
      );
      return {
        items: page.map((entry) => ({
          at: entry.at.toISOString(),
          source: entry.source,
          kind: entry.kind,
          details: entry.details,
        })),
        nextCursor,
        from: rangeFrom.toISOString(),
        to: to.toISOString(),
        capped,
        lastFetchedAt: match?.sessionsSyncedAt?.toISOString() ?? null,
        days,
      };
    },
  );

  app.post(
    '/stations/:id/sim/refresh',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: "Refresh a station's SIM data",
        description:
          'Fetches the SIM status, sessions and alerts from the provider for the last days (1, 3, 7, 14 or 31, default sim.sessions.fetchDays) or a date range of at most 31 days, and stores them. While station signal reads are on it also sends the station one GetVariables (OCPP 2.x, the DataLink values) or GetConfiguration (OCPP 1.6, sim.ocpp16.signalKeys), at most once a minute per station. Each part reports its own result; the reply is 200 whenever the request was valid. At most 6 a minute per station.',
        operationId: 'refreshStationSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(refreshBody),
        response: {
          200: itemResponse(refreshResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          429: errorWith('Too many Refreshes', [ERROR_CODES.SIM_PROVIDER_RATE_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const body = (request.body ?? {}) as z.infer<typeof refreshBody>;
      if (!(await stationAccessible(request, id)) || (await stationRow(id)) == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const simSettings = await readSimSettings();
      if (!isSimFeatureOn(simSettings)) {
        await sendFeatureDisabled(reply);
        return;
      }
      const hasRange = body.from != null || body.to != null;
      if (hasRange && (body.days != null || body.from == null || body.to == null)) {
        await reply.status(400).send({
          error: 'Send days, or from and to',
          code: 'VALIDATION_ERROR',
          reason: 'range_incomplete',
        });
        return;
      }
      const registry = simProviderRegistry();
      let period;
      try {
        period = simRefreshPeriod(
          hasRange
            ? { from: new Date(body.from ?? ''), to: new Date(body.to ?? '') }
            : { days: body.days ?? simSettings.fetchDays },
          {
            now: new Date(),
            historyDays: await simHistoryDays(registry),
            retentionDays: simSettings.retentionDays,
            defaultDays: simSettings.fetchDays,
          },
        );
      } catch (err: unknown) {
        if (!(err instanceof SimRefreshValidationError)) throw err;
        await reply.status(400).send({
          error: `The Refresh period is not valid (${err.reason}); days must be one of ${SIM_REFRESH_DAY_OPTIONS.join(', ')}`,
          code: 'VALIDATION_ERROR',
          reason: err.reason,
        });
        return;
      }

      const keys = simKeyStore();
      let count: number | null = null;
      try {
        count = await keys.increment(SIM_KEYS.refresh(id), 60);
      } catch (err: unknown) {
        request.log.warn({ err, stationId: id }, 'SIM Refresh limit not counted; Refresh allowed');
      }
      if (count != null && count > SIM_REFRESH_LIMIT_PER_MINUTE) {
        // Over the limit stays refused even when the wait cannot be read.
        const retryAfter = await secondsLeft(keys, SIM_KEYS.refresh(id), 60, request, id);
        await reply.status(429).header('Retry-After', String(retryAfter)).send({
          error: 'Too many Refreshes of this station, try again later',
          code: 'SIM_PROVIDER_RATE_LIMITED',
          retryAfter,
        });
        return;
      }

      const [provider, station] = await Promise.all([
        simSettings.hologram.enabled
          ? refreshStationSimProvider(
              { registry, keys, actor: getAuditActor(request), log: request.log },
              id,
              period,
              body.retryLookup === true ? { retryLookup: true } : {},
            )
          : Promise.resolve({ result: 'skipped', reason: 'provider_off' } as const),
        readStationDataLink({ keys, log: request.log }, id, simSettings),
      ]);
      return { provider, station };
    },
  );

  app.post(
    '/stations/:id/sim/network-reset',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: "Reset a station's SIM network",
        description:
          'Asks the SIM provider to detach the SIM from the network, so the station loses its data session and reconnects. Needs a confirmed SIM match. One reset per station a minute.',
        operationId: 'resetStationSimNetwork',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(resetResponse),
          400: errorWith('No SIM provider', [ERROR_CODES.SIM_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Not found', [ERROR_CODES.STATION_NOT_FOUND, ERROR_CODES.SIM_NOT_FOUND]),
          409: errorWith('Reset not possible', [
            ERROR_CODES.SIM_MATCH_NOT_CONFIRMED,
            ERROR_CODES.SIM_MATCHED_ELSEWHERE,
            ERROR_CODES.SIM_ACTION_UNSUPPORTED,
          ]),
          429: errorWith('Reset cooldown', [ERROR_CODES.SIM_PROVIDER_RATE_LIMITED]),
          502: errorWith('Provider request failed', [ERROR_CODES.SIM_PROVIDER_ERROR]),
          503: errorWith('Cooldown not checked', [ERROR_CODES.SIM_RESET_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      if (!(await stationAccessible(request, id)) || (await stationRow(id)) == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      if ((await simProviderRegistry().enabledProviders()).length === 0) {
        await sendNotConfigured(reply);
        return;
      }
      const match = await getStationSimMatch(id);
      if (match?.provider == null) {
        if (match?.lookupMissReason === 'sim_matched_elsewhere') {
          await reply.status(409).send({
            error: 'This SIM is matched to another station',
            code: 'SIM_MATCHED_ELSEWHERE',
          });
          return;
        }
        await reply.status(404).send({
          error: 'No SIM is matched to this station',
          code: 'SIM_NOT_FOUND',
        });
        return;
      }
      const provider = await providerOf(match.provider);
      const ref = simRefOf(match);
      if (provider == null || ref == null) {
        await sendNotConfigured(reply);
        return;
      }
      if (match.confirmedAt == null) {
        await reply.status(409).send({
          error: 'Confirm the SIM before resetting its network',
          code: 'SIM_MATCH_NOT_CONFIRMED',
        });
        return;
      }
      if (!provider.capabilities.networkReset) {
        await reply.status(409).send({
          error: 'The SIM provider does not support a network reset',
          code: 'SIM_ACTION_UNSUPPORTED',
        });
        return;
      }
      const keys = simKeyStore();
      const cooldownKey = SIM_KEYS.reset(id);
      const cooldownToken = randomUUID();
      let taken: boolean;
      try {
        taken = await keys.acquire(cooldownKey, cooldownToken, SIM_RESET_COOLDOWN_SECONDS * 1000);
      } catch (err: unknown) {
        // Without the cooldown two resets could reach the provider at once: refuse.
        request.log.warn({ err, stationId: id }, 'SIM reset cooldown not taken in Redis');
        await reply.status(503).send({
          error: 'The network reset cannot be started right now, try again in a minute',
          code: 'SIM_RESET_UNAVAILABLE',
        });
        return;
      }
      if (!taken) {
        const retryAfter = await secondsLeft(
          keys,
          cooldownKey,
          SIM_RESET_COOLDOWN_SECONDS,
          request,
          id,
        );
        await reply.status(429).header('Retry-After', String(retryAfter)).send({
          error: 'The network of this SIM was reset less than a minute ago',
          code: 'SIM_PROVIDER_RATE_LIMITED',
          retryAfter,
        });
        return;
      }

      const audit = async (outcome: 'accepted' | 'failed'): Promise<void> => {
        await recordStationCommandAudit(
          {
            stationId: id,
            actor: getAuditActor(request),
            command: 'SimNetworkReset',
            sessionId: null,
            outcome,
          },
          request.log,
        );
      };
      try {
        const result = await provider.resetNetwork(ref);
        await audit('accepted');
        return { status: result.status };
      } catch (err: unknown) {
        await audit('failed');
        if (!(err instanceof SimProviderError)) {
          // Nothing says the provider got the request, so the cooldown is given back.
          try {
            await keys.release(cooldownKey, cooldownToken);
          } catch (releaseErr: unknown) {
            request.log.warn(
              { err: releaseErr, stationId: id },
              'SIM reset cooldown not released in Redis; it expires by itself',
            );
          }
          throw err;
        }
        request.log.warn({ err, stationId: id, kind: err.kind }, 'SIM network reset failed');
        if (err.kind === 'unsupported') {
          await reply.status(409).send({
            error: 'The SIM provider refused a network reset for this SIM',
            code: 'SIM_ACTION_UNSUPPORTED',
          });
          return;
        }
        if (err.kind === 'not_found') {
          await reply.status(404).send({
            error: 'The SIM provider no longer has this SIM; clear the match and Refresh',
            code: 'SIM_NOT_FOUND',
          });
          return;
        }
        if (err.kind === 'rate_limited') {
          try {
            await keys.setFor(
              SIM_KEYS.backoff(provider.id),
              err.retryAfterSeconds ?? SIM_RESET_COOLDOWN_SECONDS,
            );
          } catch (setErr: unknown) {
            request.log.warn(
              { err: setErr, stationId: id },
              'SIM provider backoff not stored in Redis; the next Refresh may call the provider',
            );
          }
        }
        await sendSimProviderError(err, reply);
        return;
      }
    },
  );

  app.post(
    '/stations/:id/sim/match/confirm',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: "Confirm a station's SIM match",
        description:
          'Confirms that the matched SIM is the SIM in the station. Until then a Refresh fetches nothing from the provider and no reset is possible. Needs access to every site. Makes no provider call. The body names the match the person saw (its matchedAt): a match that changed since answers 409 SIM_MATCH_CHANGED and nothing is confirmed. A match already confirmed stays as it is; a SIM another station holds confirmed answers 409.',
        operationId: 'confirmStationSimMatch',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(confirmBody),
        response: {
          200: itemResponse(confirmResponse),
          400: errorWith('No SIM provider', [ERROR_CODES.SIM_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Not found', [ERROR_CODES.STATION_NOT_FOUND, ERROR_CODES.SIM_NOT_FOUND]),
          409: errorWith('Match changed or confirmed at another station', [
            ERROR_CODES.SIM_MATCH_CHANGED,
            ERROR_CODES.SIM_CONFIRMED_ELSEWHERE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      if (!(await requireAllSiteAccess(request, reply, STATION_NOT_FOUND))) return;
      if ((await stationRow(id)) == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      if ((await simProviderRegistry().enabledProviders()).length === 0) {
        await sendNotConfigured(reply);
        return;
      }
      const { matchedAt } = request.body as z.infer<typeof confirmBody>;
      const confirmed = await confirmStationSim(
        id,
        getAuditActor(request),
        new Date(matchedAt),
        request.log,
      );
      if (confirmed === 'not_matched') {
        await reply.status(404).send({
          error: 'No SIM is matched to this station',
          code: 'SIM_NOT_FOUND',
        });
        return;
      }
      if (confirmed === 'match_changed') {
        await reply.status(409).send({
          error: 'The SIM match changed since it was shown, check it and confirm again',
          code: 'SIM_MATCH_CHANGED',
        });
        return;
      }
      if (confirmed === 'confirmed_elsewhere') {
        await reply.status(409).send({
          error: 'Another station already has a confirmed match for this SIM',
          code: 'SIM_CONFIRMED_ELSEWHERE',
        });
        return;
      }
      const match = await getStationSimMatch(id);
      return { confirmed: true as const, confirmedAt: match?.confirmedAt?.toISOString() ?? null };
    },
  );

  app.delete(
    '/stations/:id/sim/match',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: "Clear a station's SIM match",
        description:
          'Forgets the SIM match and what was fetched for it; the next Refresh looks the SIM up again. Stored sessions and alerts are kept.',
        operationId: 'clearStationSimMatch',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          400: errorWith('No SIM provider', [ERROR_CODES.SIM_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Not found', [ERROR_CODES.STATION_NOT_FOUND, ERROR_CODES.SIM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      if (!(await stationAccessible(request, id)) || (await stationRow(id)) == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      if ((await simProviderRegistry().enabledProviders()).length === 0) {
        await sendNotConfigured(reply);
        return;
      }
      if (!(await clearStationSim(id, getAuditActor(request), request.log))) {
        await reply.status(404).send({
          error: 'No SIM is matched to this station',
          code: 'SIM_NOT_FOUND',
        });
        return;
      }
      return { success: true as const };
    },
  );
}
