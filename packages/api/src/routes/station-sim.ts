// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  chargingStations,
  connectionLogs,
  db,
  getSim,
  getSimByIccid,
  getSystemTimezone,
  openSimAttachment,
  openStationAttachment,
  settings,
  simAlerts,
  simSessions,
  sites,
  stationEvents,
  users,
  variableMonitoringRules,
  type Sim,
  type SimAttachment,
} from '@evtivity/database';
import { normalizeIccid, SIM_RANGE_MAX_DAYS, SIM_REFRESH_DAY_OPTIONS } from '@evtivity/lib';
import {
  atInWindows,
  fetchedAfterFloor,
  refreshStationSimProvider,
  resetSimNetwork,
  SIM_KEYS,
  simCoveredDays,
  simHistoryDays,
  simRefOf,
  simRefreshPeriod,
  SimRefreshValidationError,
  readStationDataLink,
  spanInWindows,
  stationDisconnectCauses,
  stationSignalSnapshot,
  stationSimView,
  type SimProvider,
  type SimProviderId,
} from '@evtivity/services/station-sim.service';
import {
  confirmStationAttachment,
  detachStationSim,
  type SimActor,
} from '@evtivity/services/sim-inventory.service';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse, successResponse } from '../lib/response-schemas.js';
import { ERROR_CODES, ERROR_MESSAGES } from '../lib/error-codes.generated.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  checkStationSiteAccess,
  getUserSiteIds,
  requireAllSiteAccess,
} from '../lib/site-access.js';
import { recordStationCommandAudit } from '../lib/station-command-audit.js';
import {
  anySimProviderEnabled,
  isSimFeatureOn,
  readSimSettings,
  simProviderRegistry,
} from '../lib/sim.js';
import { simKeyStore } from '../lib/sim-keys.js';
import {
  simAlertItem,
  simSessionItem,
  timelineEntries,
  timelineIdsOf,
  timelinePageKeys,
  timelinePageOut,
  timelinePaging,
  timelinePagingQueryFields,
  timelinePagingResponseFields,
  type TimelineItem,
  type TimelineRank,
  type TimelineSourceSpec,
} from '../lib/sim-timeline.js';
import { visibleUserIds } from '../lib/user-management-scope.js';
import { sendSimProviderError } from './sim-provider-settings.js';
import type { JwtPayload } from '../plugins/auth.js';

const DAY_MS = 86_400_000;
/** Refreshes per station a minute, across API pods. */
export const SIM_REFRESH_LIMIT_PER_MINUTE = 6;
/** SIM alerts the status shows; the timeline lists them all. */
const RECENT_ALERTS = 5;
const CONNECTION_LOG_RETENTION_KEY = 'logs.connection.retentionDays';
const CONNECTION_LOG_RETENTION_DEFAULT = 90;

const STATION_NOT_FOUND = { error: 'Station not found', code: 'STATION_NOT_FOUND' } as const;
const SIM_NOT_FOUND = { error: ERROR_MESSAGES.SIM_NOT_FOUND, code: 'SIM_NOT_FOUND' } as const;
const SIM_INACTIVE = { error: ERROR_MESSAGES.SIM_INACTIVE, code: 'SIM_INACTIVE' } as const;

const stationParams = z.object({ id: ID_PARAMS.stationId.describe('Station ID') });

const capabilitiesSchema = z
  .object({
    networkName: z.boolean().describe('Reports the network name of a session'),
    radioAccessTechnology: z.boolean().describe('Reports the radio access technology'),
    cellId: z.boolean().describe('Reports the cell ID'),
    usage: z.boolean().describe('Reports the data usage of the billing period'),
    sessions: z.boolean().describe('Lists data sessions'),
    alerts: z.boolean().describe('Lists SIM alerts'),
    networkReset: z.boolean().describe('Can reset the SIM network connection'),
  })
  .loose()
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
      .loose()
      .nullable()
      .describe('Data used this billing period'),
  })
  .loose();

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
  .loose();

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
      .record(z.string(), z.string().nullable())
      .describe('Every stored value by name: DataLink[instance].Variable, or the 1.6 key'),
    dataLinks: z
      .array(
        z
          .object({
            instance: z.string().nullable().describe('The DataLink component instance'),
            values: z.record(z.string(), z.string().nullable()),
            signalUnit: z.string().nullable(),
            signal: signalReadingSchema.nullable(),
          })
          .loose(),
      )
      .describe('One entry per DataLink instance (OCPP 2.x)'),
    activeNetworkProfile: z.string().nullable(),
    thresholds: z.object({ goodDbm: z.number(), fairDbm: z.number() }).loose(),
  })
  .loose();

const simStatusResponse = z
  .object({
    provider: z.string().nullable().describe('The SIM provider, null when no SIM data is shown'),
    reason: z
      .enum([
        'no_iccid',
        'no_provider_configured',
        'not_looked_up',
        'not_found',
        'attached_elsewhere',
        'sim_inactive',
      ])
      .nullable()
      .describe(
        'Why there is no provider, null when there is one. attached_elsewhere: the SIM of the ICCID the station holds is attached to another target; sim_inactive: that SIM is inactive',
      ),
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
      .loose()
      .nullable()
      .describe('Network of the newest stored session'),
    attachment: z
      .object({
        id: z.number().int().describe('The attachment id; Confirm SIM sends it back'),
        simId: z.string().describe('The SIM of the attachment'),
        source: z
          .enum(['reported', 'entered', 'attached', 'imported'])
          .describe(
            'Where the attachment came from: the ICCID the station reported, an ICCID entered on the station, an attach on the SIM page, or a CSV import',
          ),
        attachedAt: z.string(),
        attachedBy: z
          .object({
            id: z.string(),
            name: z.string().nullable().describe('First and last name, null when not set'),
          })
          .loose()
          .nullable()
          .describe(
            'The person who attached the SIM; null for a station report or a person a site-restricted reader may not see (an all-site user or a user of another site)',
          ),
        confirmedAt: z
          .string()
          .nullable()
          .describe(
            'When a person with access to every site confirmed the SIM. Until then nothing is fetched from the provider and no reset is possible',
          ),
      })
      .loose()
      .nullable()
      .describe("The station's open SIM attachment, null without one"),
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
          .loose(),
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
  .loose();

const timelineQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe('Start, default 24 hours ago'),
  to: z.iso.datetime({ offset: true }).optional().describe('End, default and at most now'),
  ...timelinePagingQueryFields,
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
      .record(z.string(), z.unknown())
      .describe(
        'Fields of the item. A disconnect carries offlineCause: server, sim_account, station, network, pending or unknown, computed from stored data',
      ),
  })
  .loose();

const timelineResponse = z
  .object({
    items: z.array(timelineItem),
    ...timelinePagingResponseFields,
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
          .loose(),
      )
      .describe('What the stored SIM data of each day can show, in the station time zone'),
  })
  .loose();

const refreshBody = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(SIM_RANGE_MAX_DAYS)
    .optional()
    .describe('Days to fetch back from now: 1, 3, 7, 14 or 31; default sim.sessions.fetchDays'),
  from: z.iso.datetime({ offset: true }).optional().describe('Start of a date range'),
  to: z.iso.datetime({ offset: true }).optional().describe('End of a date range'),
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
        'provider_off, backoff, in_progress, no_iccid, not_found, attached_elsewhere (the SIM is attached to another target; no attachment is made), attach_conflict (other changes to the SIM attachments ran at the same time; nothing was attached, a later Refresh tries again) or not_confirmed (nothing is fetched until Confirm SIM) for a skipped part',
      ),
    kind: z.string().optional().describe('The error kind of a failed part'),
    provider: z.string().optional(),
    fetchedAt: z.string().optional(),
    sessionsStored: z.number().optional(),
    alertsStored: z.number().optional(),
    retryAfter: z.number().optional(),
  })
  .loose();

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
      .loose()
      .describe('The station signal part'),
  })
  .loose();

const resetResponse = z
  .object({
    status: z
      .enum(['accepted', 'submitted'])
      .describe(
        'accepted: the provider reset the network (Hologram). submitted: the provider queued the reset, which runs within a few minutes (1NCE).',
      ),
  })
  .loose();

const confirmResponse = z
  .object({ confirmed: z.literal(true), confirmedAt: z.string().nullable() })
  .loose();

const confirmBody = z.object({
  attachmentId: z
    .number()
    .int()
    .min(1)
    .describe(
      'The attachment id the confirmation showed (GET /v1/stations/{id}/sim). An attachment that changed since answers 409 SIM_ATTACHMENT_CHANGED.',
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

/** The person who acts, for the SIM and station audit rows (an API key counts as its user). */
function simActorOf(request: FastifyRequest): SimActor {
  const audit = getAuditActor(request);
  return { audit, userId: audit.actorUserId };
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

interface AttachmentView {
  id: number;
  simId: string;
  source: SimAttachment['source'];
  attachedAt: string;
  attachedBy: { id: string; name: string | null } | null;
  confirmedAt: string | null;
}

/**
 * The attachment as the status shows it, with the person who attached the
 * SIM. A site-restricted viewer never sees an all-site user or a user of
 * another site named (`visibleUserIds`): that person is null for them.
 */
async function attachmentView(
  attachment: SimAttachment,
  request: FastifyRequest,
): Promise<AttachmentView> {
  let attachedBy: AttachmentView['attachedBy'] = null;
  const { userId } = request.user as JwtPayload;
  const visible =
    attachment.attachedBy == null
      ? null
      : await visibleUserIds([attachment.attachedBy], userId, await getUserSiteIds(userId));
  if (attachment.attachedBy != null && (visible == null || visible.has(attachment.attachedBy))) {
    const [user] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, attachment.attachedBy));
    const name = [user?.firstName, user?.lastName]
      .filter((part): part is string => part != null && part.trim() !== '')
      .join(' ');
    attachedBy = { id: attachment.attachedBy, name: name === '' ? null : name };
  }
  return {
    id: attachment.id,
    simId: attachment.simId,
    source: attachment.source,
    attachedAt: attachment.attachedAt.toISOString(),
    attachedBy,
    confirmedAt: attachment.confirmedAt?.toISOString() ?? null,
  };
}

/**
 * The SIM a station tab action is about: the SIM of the station's open
 * attachment, else the SIM of the ICCID the station holds (null when none is
 * stored yet). Database only.
 */
async function stationSimOf(
  stationId: string,
  stationIccid: string | null,
): Promise<{ sim: Sim | null; attachment: SimAttachment | null }> {
  const attachment = await openStationAttachment(stationId);
  if (attachment != null) return { sim: await getSim(attachment.simId), attachment };
  const iccid = normalizeIccid(stationIccid);
  return { sim: iccid == null ? null : await getSimByIccid(iccid), attachment: null };
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
  if (typeof days !== 'number' || !Number.isFinite(days)) return CONNECTION_LOG_RETENTION_DEFAULT;
  // 0 or less keeps the connection log forever (log-retention-prune skips it): no bound.
  return days > 0 ? days : Number.POSITIVE_INFINITY;
}

/** The enabled provider with this id, or null. */
async function providerOf(id: string | null): Promise<SimProvider | null> {
  if (id == null) return null;
  return simProviderRegistry().getProvider(id as SimProviderId);
}

/** The timeline sources; at one time their items sort by source, then by row id, newest first. */
type TimelineSource = 'sim:session' | 'sim:alert' | 'ocpp:event' | 'ocpp';
const SOURCE_RANK: TimelineRank<TimelineSource> = {
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

/**
 * The SQL twin of `signalEventItems`: the NotifyEvent row holds at least one
 * low signal item, so every timeline entry of a row gives an item and the
 * page count matches what the pages show.
 */
function hasLowSignalItem(stationId: string): SQL {
  return sql`CASE WHEN jsonb_typeof(${stationEvents.eventData}) = 'array' THEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(${stationEvents.eventData}) AS item
    WHERE item->'component'->>'name' = 'DataLink'
      AND item->'variable'->>'name' = 'SignalStrength'
      AND item->>'trigger' = 'Alerting'
      AND (
        coalesce(jsonb_typeof(item->'variableMonitoringId'), '') <> 'number'
        OR (item->>'variableMonitoringId')::numeric IN (
          SELECT ${variableMonitoringRules.monitoringId} FROM ${variableMonitoringRules}
          WHERE ${variableMonitoringRules.stationId} = ${stationId}
            AND ${variableMonitoringRules.source} = 'low_signal'
        )
      )
  ) ELSE false END`;
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
          "The SIM status, the station's SIM attachment and the network stored by the last Refresh. Reads the database only: no provider call and no OCPP command.",
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
      const station = await stationRow(id);
      if (station == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const { sim, attachment } = await stationSimOf(id, station.iccid);
      const registry = simProviderRegistry();
      const enabled = await registry.enabledProviders();
      const provider = attachment != null ? await providerOf(sim?.provider ?? null) : null;
      const common = {
        historyDays: provider?.historyDays ?? (await simHistoryDays(registry)),
        reportingDelayHours: provider?.reportingDelayHours ?? null,
        fetchDays: simSettings.fetchDays,
        retentionDays: simSettings.retentionDays,
        coverageTimeZone: await coverageTimeZone(station),
        station: simSettings.stationSignalEnabled
          ? await stationSignalSnapshot(id, simSettings)
          : null,
        attachment: attachment != null ? await attachmentView(attachment, request) : null,
      };
      const empty = {
        status: null,
        statusFetchedAt: null,
        network: null,
        lastFetchedAt: null,
        recentAlerts: [],
      };
      if (attachment == null || sim == null || provider == null || simRefOf(sim) == null) {
        let reason:
          | 'no_iccid'
          | 'no_provider_configured'
          | 'not_looked_up'
          | 'not_found'
          | 'attached_elsewhere'
          | 'sim_inactive';
        if (enabled.length === 0 || (attachment != null && sim?.provider != null)) {
          reason = 'no_provider_configured';
        } else if (attachment == null && normalizeIccid(station.iccid) == null) reason = 'no_iccid';
        else if (sim?.status === 'inactive') reason = 'sim_inactive';
        else if (attachment == null && sim != null && (await openSimAttachment(sim.id)) != null) {
          reason = 'attached_elsewhere';
        } else if (attachment != null && sim?.lookupMissReason === 'not_found')
          reason = 'not_found';
        else reason = 'not_looked_up';
        return { provider: null, reason, capabilities: null, ...empty, ...common };
      }
      // An unconfirmed attachment fetched nothing and shows nothing of the SIM.
      if (attachment.confirmedAt == null) {
        return {
          provider: provider.id,
          reason: null,
          capabilities: provider.capabilities,
          ...empty,
          ...common,
        };
      }
      // Only rows and fetch state after the SIM's history floor: its time
      // at another station (another site, or a deleted one) never shows here.
      const windows = (await stationSimView(id))?.windows ?? [];
      const statusHere = fetchedAfterFloor(sim.statusFetchedAt, sim);
      const syncedHere = fetchedAfterFloor(sim.sessionsSyncedAt, sim);
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
              eq(simSessions.simId, sim.id),
              spanInWindows(simSessions.startedAt, simSessions.endedAt, windows),
            ),
          )
          .orderBy(desc(simSessions.endedAt), desc(simSessions.id))
          .limit(1),
        db
          .select({ kind: simAlerts.kind, receivedAt: simAlerts.receivedAt })
          .from(simAlerts)
          .where(and(eq(simAlerts.simId, sim.id), atInWindows(simAlerts.receivedAt, windows)))
          .orderBy(desc(simAlerts.receivedAt), desc(simAlerts.id))
          .limit(RECENT_ALERTS),
      ]);
      return {
        provider: provider.id,
        reason: null,
        capabilities: provider.capabilities,
        status: statusHere ? (sim.lastStatus ?? null) : null,
        statusFetchedAt: statusHere ? (sim.statusFetchedAt?.toISOString() ?? null) : null,
        network:
          newest == null
            ? null
            : {
                name: newest.networkName,
                radioAccessTechnology: newest.radioAccessTechnology,
                cellId: newest.cellId,
                observedAt: newest.endedAt.toISOString(),
              },
        lastFetchedAt: syncedHere ? (sim.sessionsSyncedAt?.toISOString() ?? null) : null,
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
          'The stored SIM sessions and alerts and the OCPP connects and disconnects of the station in one list, newest first, plus what each day of the range has stored. Paged by page number (page, limit, total) or by cursor. Reads the database only. The range is at most 31 days and within the SIM and connection log retentions; a longer one is shortened (capped).',
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
      const paging = timelinePaging(query, SOURCE_RANK);
      if ('error' in paging) {
        await reply.status(400).send({ error: paging.error, code: 'VALIDATION_ERROR' });
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
      // Only the rows of the SIM of the confirmed attachment, and only after the
      // SIM's history floor: data of an earlier SIM of the station never
      // shows, nor of an unconfirmed one, nor the SIM's data from another station.
      const view = await stationSimView(id);
      const sim = view?.sim ?? null;
      const windows = view?.windows ?? [];

      const sources: Array<TimelineSourceSpec<TimelineSource>> = [
        {
          from: 'ocpp',
          table: connectionLogs,
          id: connectionLogs.id,
          at: connectionLogs.createdAt,
          where: and(
            eq(connectionLogs.stationId, id),
            inArray(connectionLogs.event, ['connected', 'disconnected']),
            gte(connectionLogs.createdAt, rangeFrom),
            lte(connectionLogs.createdAt, to),
          ),
        },
        {
          from: 'ocpp:event',
          table: stationEvents,
          id: stationEvents.id,
          at: stationEvents.generatedAt,
          where: and(
            eq(stationEvents.stationId, id),
            gte(stationEvents.generatedAt, rangeFrom),
            lte(stationEvents.generatedAt, to),
            sql`${stationEvents.eventData} @> ${SIGNAL_EVENT_MATCH}::jsonb`,
            hasLowSignalItem(id),
          ),
        },
      ];
      if (sim != null) {
        sources.push(
          // A session that began before the range but ended in it belongs to the range.
          {
            from: 'sim:session',
            table: simSessions,
            id: simSessions.id,
            at: simSessions.startedAt,
            where: and(
              eq(simSessions.simId, sim.id),
              gte(simSessions.endedAt, rangeFrom),
              lte(simSessions.startedAt, to),
              spanInWindows(simSessions.startedAt, simSessions.endedAt, windows),
            ),
          },
          {
            from: 'sim:alert',
            table: simAlerts,
            id: simAlerts.id,
            at: simAlerts.receivedAt,
            where: and(
              eq(simAlerts.simId, sim.id),
              gte(simAlerts.receivedAt, rangeFrom),
              lte(simAlerts.receivedAt, to),
              atInWindows(simAlerts.receivedAt, windows),
            ),
          },
        );
      }
      const pageKeys = await timelinePageKeys(SOURCE_RANK, sources, paging);
      // The rows of the page's entries, by id; every one passed the conditions above.
      const sessionIds = timelineIdsOf(pageKeys.keys, 'sim:session');
      const alertIds = timelineIdsOf(pageKeys.keys, 'sim:alert');
      const signalIds = timelineIdsOf(pageKeys.keys, 'ocpp:event');
      const connectionIds = timelineIdsOf(pageKeys.keys, 'ocpp');
      const [sessionRows, alertRows, connectionRows, signalRows, monitorRows] = await Promise.all([
        sessionIds.length === 0
          ? []
          : db.select().from(simSessions).where(inArray(simSessions.id, sessionIds)),
        alertIds.length === 0
          ? []
          : db.select().from(simAlerts).where(inArray(simAlerts.id, alertIds)),
        connectionIds.length === 0
          ? []
          : db
              .select({
                id: connectionLogs.id,
                event: connectionLogs.event,
                metadata: connectionLogs.metadata,
              })
              .from(connectionLogs)
              .where(inArray(connectionLogs.id, connectionIds)),
        signalIds.length === 0
          ? []
          : db
              .select({ id: stationEvents.id, eventData: stationEvents.eventData })
              .from(stationEvents)
              .where(inArray(stationEvents.id, signalIds)),
        signalIds.length === 0
          ? []
          : db
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
      const itemsBySource: Record<TimelineSource, Map<number, TimelineItem[]>> = {
        'sim:session': new Map(sessionRows.map((s) => [s.id, [simSessionItem(s)]])),
        'sim:alert': new Map(alertRows.map((a) => [a.id, [simAlertItem(a)]])),
        // A NotifyEvent row can hold several low signal items; they share its entry.
        'ocpp:event': new Map(
          signalRows.map((e) => [
            e.id,
            signalEventItems(e.eventData, lowSignalMonitorIds).map((item): TimelineItem => {
              const component = item.component as { instance?: unknown };
              return {
                source: 'ocpp',
                kind: item.cleared === true ? 'signal_restored' : 'signal_low',
                details: {
                  instance: typeof component.instance === 'string' ? component.instance : null,
                  actualValue: typeof item.actualValue === 'string' ? item.actualValue : null,
                },
              };
            }),
          ]),
        ),
        ocpp: new Map(
          connectionRows.map((c) => {
            const reason = (c.metadata as { reason?: unknown } | null)?.reason;
            return [
              c.id,
              [
                {
                  source: 'ocpp' as const,
                  kind: c.event,
                  details: typeof reason === 'string' ? { reason } : {},
                },
              ],
            ];
          }),
        ),
      };
      const page = timelineEntries(pageKeys.keys, (from, rowId) => itemsBySource[from].get(rowId));
      const provider = await providerOf(sim?.provider ?? null);
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
      const days = await simCoveredDays(
        sim?.id ?? null,
        rangeFrom,
        to,
        await coverageTimeZone(station),
        {
          historyDays: provider?.historyDays ?? (await simHistoryDays(simProviderRegistry())),
          retentionDays: simSettings.retentionDays,
          reportingDelayHours: provider?.reportingDelayHours ?? 0,
          windows,
        },
        now,
      );
      return {
        ...timelinePageOut(paging, pageKeys, page),
        from: rangeFrom.toISOString(),
        to: to.toISOString(),
        capped,
        lastFetchedAt:
          view != null && fetchedAfterFloor(view.sim.sessionsSyncedAt, view.sim)
            ? (view.sim.sessionsSyncedAt?.toISOString() ?? null)
            : null,
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
          'Fetches the SIM status, sessions and alerts from the provider for the last days (1, 3, 7, 14 or 31, default sim.sessions.fetchDays) or a date range of at most 31 days, and stores them. Without a SIM attachment the ICCID the station reported is attached unconfirmed, unless that SIM is attached elsewhere; nothing is fetched until Confirm SIM. An inactive SIM answers 409 SIM_INACTIVE. While station signal reads are on it also sends the station one GetVariables (OCPP 2.x, the DataLink values) or GetConfiguration (OCPP 1.6, sim.ocpp16.signalKeys), at most once a minute per station. Each part reports its own result; the reply is 200 whenever the request was valid. At most 6 a minute per station.',
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
          409: errorWith('The SIM is inactive', [ERROR_CODES.SIM_INACTIVE]),
          429: errorWith('Too many Refreshes', [ERROR_CODES.SIM_PROVIDER_RATE_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const body = (request.body ?? {}) as z.infer<typeof refreshBody>;
      const station = (await stationAccessible(request, id)) ? await stationRow(id) : null;
      if (station == null) {
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

      // An inactive SIM is never refreshed: refused before either part starts.
      if (anySimProviderEnabled(simSettings)) {
        const { sim } = await stationSimOf(id, station.iccid);
        if (sim?.status === 'inactive') {
          await reply.status(409).send(SIM_INACTIVE);
          return;
        }
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

      const [provider, stationPart] = await Promise.all([
        anySimProviderEnabled(simSettings)
          ? refreshStationSimProvider(
              { registry, keys, actor: getAuditActor(request), log: request.log },
              id,
              period,
              body.retryLookup === true ? { retryLookup: true } : {},
            )
          : Promise.resolve({ result: 'skipped', reason: 'provider_off' } as const),
        readStationDataLink({ keys, log: request.log }, id, simSettings),
      ]);
      // Deactivated between the check and the provider part: no provider was called.
      if (provider.result === 'skipped' && provider.reason === 'sim_inactive') {
        await reply.status(409).send(SIM_INACTIVE);
        return;
      }
      return { provider, station: stationPart };
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
          'Asks the SIM provider to detach the SIM from the network, so the station loses its data session and reconnects. Needs a confirmed SIM attachment. One reset per SIM a minute, shared with the SIM page.',
        operationId: 'resetStationSimNetwork',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(resetResponse),
          400: errorWith('No SIM provider', [ERROR_CODES.SIM_PROVIDER_NOT_CONFIGURED]),
          404: errorWith('Not found', [ERROR_CODES.STATION_NOT_FOUND, ERROR_CODES.SIM_NOT_FOUND]),
          409: errorWith('Reset not possible', [
            ERROR_CODES.SIM_ATTACHMENT_NOT_CONFIRMED,
            ERROR_CODES.SIM_INACTIVE,
            ERROR_CODES.SIM_ACTION_UNSUPPORTED,
          ]),
          429: errorWith('Reset cooldown or provider limit', [
            ERROR_CODES.SIM_PROVIDER_RATE_LIMITED,
          ]),
          502: errorWith('Provider request failed', [ERROR_CODES.SIM_PROVIDER_ERROR]),
          503: errorWith('Cooldown not checked', [ERROR_CODES.SIM_RESET_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const station = (await stationAccessible(request, id)) ? await stationRow(id) : null;
      if (station == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const registry = simProviderRegistry();
      if ((await registry.enabledProviders()).length === 0) {
        await sendNotConfigured(reply);
        return;
      }
      const { sim, attachment } = await stationSimOf(id, station.iccid);
      if (attachment == null) {
        // An inactive SIM is never attached: say so rather than "not found".
        await reply
          .status(sim?.status === 'inactive' ? 409 : 404)
          .send(sim?.status === 'inactive' ? SIM_INACTIVE : SIM_NOT_FOUND);
        return;
      }
      if (attachment.confirmedAt == null) {
        await reply.status(409).send({
          error: ERROR_MESSAGES.SIM_ATTACHMENT_NOT_CONFIRMED,
          code: 'SIM_ATTACHMENT_NOT_CONFIRMED',
        });
        return;
      }
      const actor = getAuditActor(request);
      const outcome = await resetSimNetwork(
        { registry, keys: simKeyStore(), actor, log: request.log },
        attachment.simId,
        {
          // The SIM must still be confirmed at this station once the cooldown is
          // taken: a detach and an attach elsewhere meanwhile would move the
          // reset to another site's station.
          stillAllowed: async () => {
            const current = await openStationAttachment(id);
            return current?.id === attachment.id && current.confirmedAt != null;
          },
          // The station command audit stays on the station the person reset from.
          onOutcome: async (result) => {
            await recordStationCommandAudit(
              {
                stationId: id,
                actor,
                command: 'SimNetworkReset',
                sessionId: null,
                outcome: result,
              },
              request.log,
            );
          },
        },
      );
      switch (outcome.kind) {
        case 'reset':
          return { status: outcome.status };
        case 'sim_not_found':
        case 'not_looked_up':
          await reply.status(404).send(SIM_NOT_FOUND);
          return;
        case 'sim_inactive':
          await reply.status(409).send(SIM_INACTIVE);
          return;
        case 'provider_off':
          await sendNotConfigured(reply);
          return;
        case 'unsupported':
          await reply.status(409).send({
            error: 'The SIM provider does not support a network reset',
            code: 'SIM_ACTION_UNSUPPORTED',
          });
          return;
        case 'cooldown':
          await reply.status(429).header('Retry-After', String(outcome.retryAfter)).send({
            error: 'The network of this SIM was reset less than a minute ago',
            code: 'SIM_PROVIDER_RATE_LIMITED',
            retryAfter: outcome.retryAfter,
          });
          return;
        case 'unavailable':
          await reply.status(503).send({
            error: ERROR_MESSAGES.SIM_RESET_UNAVAILABLE,
            code: 'SIM_RESET_UNAVAILABLE',
          });
          return;
        case 'provider_error':
          if (outcome.error.kind === 'unsupported') {
            await reply.status(409).send({
              error: 'The SIM provider refused a network reset for this SIM',
              code: 'SIM_ACTION_UNSUPPORTED',
            });
            return;
          }
          if (outcome.error.kind === 'not_found') {
            await reply.status(404).send({
              error: 'The SIM provider no longer has this SIM; detach it and Refresh',
              code: 'SIM_NOT_FOUND',
            });
            return;
          }
          await sendSimProviderError(outcome.error, reply);
          return;
      }
    },
  );

  app.post(
    '/stations/:id/sim/attachment/confirm',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: "Confirm a station's SIM attachment",
        description:
          'Confirms that the attached SIM is the SIM in the station. Until then a Refresh fetches nothing from the provider and no reset is possible. Needs access to every site. Makes no provider call. The body names the attachment the person saw (its id): an attachment that changed since answers 409 SIM_ATTACHMENT_CHANGED and nothing is confirmed. An attachment already confirmed stays as it is.',
        operationId: 'confirmStationSimAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(confirmBody),
        response: {
          200: itemResponse(confirmResponse),
          400: errorWith('SIM features off', [ERROR_CODES.SIM_FEATURE_DISABLED]),
          404: errorWith('Not found', [ERROR_CODES.STATION_NOT_FOUND, ERROR_CODES.SIM_NOT_FOUND]),
          409: errorWith('Attachment changed or SIM inactive', [
            ERROR_CODES.SIM_ATTACHMENT_CHANGED,
            ERROR_CODES.SIM_INACTIVE,
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
      if (!isSimFeatureOn(await readSimSettings())) {
        await sendFeatureDisabled(reply);
        return;
      }
      const { attachmentId } = request.body as z.infer<typeof confirmBody>;
      const confirmed = await confirmStationAttachment(id, attachmentId, {
        actor: simActorOf(request),
        log: request.log,
      });
      if (confirmed === 'not_attached') {
        await reply.status(404).send(SIM_NOT_FOUND);
        return;
      }
      if (confirmed === 'attachment_changed') {
        await reply.status(409).send({
          error: ERROR_MESSAGES.SIM_ATTACHMENT_CHANGED,
          code: 'SIM_ATTACHMENT_CHANGED',
        });
        return;
      }
      if (confirmed === 'sim_inactive') {
        await reply.status(409).send(SIM_INACTIVE);
        return;
      }
      const attachment = await openStationAttachment(id);
      return {
        confirmed: true as const,
        confirmedAt: attachment?.confirmedAt?.toISOString() ?? null,
      };
    },
  );

  app.delete(
    '/stations/:id/sim/attachment',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: "Detach a station's SIM",
        description:
          "Closes the station's SIM attachment. The SIM, its history and its stored sessions and alerts are kept; the next Refresh attaches the SIM of the ICCID the station reported, unconfirmed.",
        operationId: 'detachStationSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          400: errorWith('SIM features off', [ERROR_CODES.SIM_FEATURE_DISABLED]),
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
      if (!isSimFeatureOn(await readSimSettings())) {
        await sendFeatureDisabled(reply);
        return;
      }
      const detached = await detachStationSim(id, { actor: simActorOf(request), log: request.log });
      if (detached == null) {
        await reply.status(404).send(SIM_NOT_FOUND);
        return;
      }
      return { success: true as const };
    },
  );
}
