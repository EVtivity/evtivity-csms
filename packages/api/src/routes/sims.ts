// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSystemTimezone, openSimAttachment } from '@evtivity/database';
import { isValidIccid, SIM_RANGE_MAX_DAYS, SIM_REFRESH_DAY_OPTIONS } from '@evtivity/lib';
import {
  attachSim,
  confirmStationAttachment,
  deactivateSim,
  deleteSim,
  detachSimAttachment,
  ensureSim,
  reactivateSim,
  updateSim,
  type SimActor,
} from '@evtivity/services/sim-inventory.service';
import {
  refreshSimProvider,
  resetSimNetwork,
  SIM_KEYS,
  simCoveredDays,
  simHistoryDays,
  simRefreshPeriod,
  SimRefreshValidationError,
  type SimProvider,
  type SimProviderId,
} from '@evtivity/services/station-sim.service';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { parseZodRequest, rejectUnknownBodyKeys, zodSchema } from '../lib/zod-schema.js';
import {
  errorWith,
  itemResponse,
  paginatedResponse,
  successResponse,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { ID_PARAMS, prefixedId } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  checkStationSiteAccess,
  getUserSiteIds,
  requireAllSiteAccess,
} from '../lib/site-access.js';
import { recordStationCommandAudit } from '../lib/station-command-audit.js';
import { readSimSettings, simProviderRegistry } from '../lib/sim.js';
import { simKeyStore } from '../lib/sim-keys.js';
import { SIM_NOT_FOUND, simFeatureOnRequest } from '../lib/sim-site-scope.js';
import {
  attachmentViewById,
  listSimViews,
  simAttachmentHistory,
  simDetailView,
  simSiteWindows,
  simViewById,
  stationForAttach,
  visibleSim,
  type SimView,
  type SimViewer,
} from '../lib/sim-views.js';
import {
  SIM_TIMELINE_RANK,
  simTimelinePage,
  timelinePaging,
  timelinePagingQueryFields,
  timelinePagingResponseFields,
} from '../lib/sim-timeline.js';
import {
  exportSimsCsv,
  exportSimTemplateCsv,
  importSimsCsv,
  SIM_IMPORT_MAX_ROWS,
} from '../services/sim-import.service.js';
import { sendSimProviderError } from './sim-provider-settings.js';
import type { JwtPayload } from '../plugins/auth.js';

// The SIM inventory routes (`/v1/sims`).
// Every route answers 400 SIM_FEATURE_DISABLED first while the provider and
// the station signal reads are both off. A site-restricted user sees a
// SIM only through an open confirmed attachment to a station of their sites,
// else 404 SIM_NOT_FOUND. Only Refresh and Network Reset call a
// provider. Writes go through `@evtivity/services/sim-inventory.service`,
// which writes the SIM and station audit rows.

const DAY_MS = 86_400_000;
/** Refreshes per SIM a minute on the SIM page, across API pods. */
export const SIM_PAGE_REFRESH_LIMIT_PER_MINUTE = 6;
/** SIM alerts the detail shows; the timeline lists them all. */
const RECENT_ALERTS = 5;

const SIM_PROVIDER_STATES = [
  'active',
  'pending',
  'suspended',
  'inactive',
  'deactivated',
  'test',
  'unknown',
] as const;

const STATION_NOT_FOUND = { error: 'Station not found', code: 'STATION_NOT_FOUND' } as const;

const simParams = z.object({ id: prefixedId('sim').describe('SIM ID') });
const attachmentParams = z.object({
  id: prefixedId('sim').describe('SIM ID'),
  attachmentId: z.coerce
    .number()
    .int()
    .min(1)
    .describe('The attachment id the person saw (GET /v1/sims/{id})'),
});

const imsiField = z
  .string()
  .regex(/^\d{1,15}$/, 'An IMSI is up to 15 digits')
  .describe('IMSI, up to 15 digits');
const labelField = z.string().max(100).describe('Label, at most 100 characters');
const notesField = z.string().max(2000).describe('Notes, at most 2000 characters');

const listQuery = paginationQuery.extend({
  search: z.string().max(100).optional().describe('Part of the ICCID, IMSI or label'),
  provider: z.string().max(32).optional().describe('The SIM provider, such as hologram'),
  attachment: z
    .enum(['attached', 'unattached', 'unconfirmed'])
    .optional()
    .describe(
      'attached: an open attachment; unattached: none; unconfirmed: an open attachment not confirmed yet',
    ),
  status: z
    .enum(['active', 'inactive'])
    .optional()
    .describe('The CSMS status set by Deactivate and Reactivate'),
  state: z
    .enum(SIM_PROVIDER_STATES)
    .optional()
    .describe('The provider state stored by the last Refresh'),
  stationId: ID_PARAMS.stationId.optional().describe('Only the SIM attached to this station'),
});

const createBody = z.object({
  iccid: z.string().max(22).describe('ICCID: 19 digits with an optional trailing F, or 20 digits'),
  imsi: imsiField.optional(),
  label: labelField.optional(),
  notes: notesField.optional(),
});

const updateBody = z.object({
  label: labelField.nullable().optional().describe('Label; null removes it'),
  notes: notesField.nullable().optional().describe('Notes; null removes them'),
  imsi: imsiField.nullable().optional().describe('IMSI, up to 15 digits; null removes it'),
});

const attachBody = z.object({
  stationId: ID_PARAMS.stationId.describe('The station to attach the SIM to'),
});

// The CSV columns the import reads; the export-only columns of a re-imported
// export (status, provider, providerState, attachedStationId,
// attachmentConfirmed) are dropped. Cells are checked per row
// (`Row N: <reason>`), so the caps here only bound the body.
const importRow = z.object({
  iccid: z.string().max(64).describe('ICCID: 19 digits with an optional trailing F, or 20 digits'),
  imsi: z.string().max(64).optional().describe('IMSI, up to 15 digits; empty keeps it'),
  label: z.string().max(1000).optional().describe('Label, at most 100 characters; empty keeps it'),
  notes: z
    .string()
    .max(10_000)
    .optional()
    .describe('Notes, at most 2000 characters; empty keeps them'),
  stationId: z
    .string()
    .max(255)
    .optional()
    .describe('OCPP identity of the station to attach the SIM to; empty attaches nothing'),
});

const importBody = z.object({
  rows: z.array(importRow).max(SIM_IMPORT_MAX_ROWS).describe('Parsed CSV rows, at most 10000'),
  updateExisting: z
    .boolean()
    .describe('When true, updates the IMSI, label and notes of SIMs that already exist'),
});

const importResultResponse = z
  .object({
    created: z.number().int().describe('SIMs created'),
    updated: z.number().int().describe('Existing SIMs whose IMSI, label or notes changed'),
    attached: z.number().int().describe('Attachments made (source imported)'),
    errors: z
      .array(z.string())
      .describe('One "Row N: <reason>" per row refused or skipped; such a row changes nothing'),
  })
  .loose();

const timelineQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe('Start, default 24 hours ago'),
  to: z.iso.datetime({ offset: true }).optional().describe('End, default and at most now'),
  ...timelinePagingQueryFields,
});

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

const storedStatusSchema = z
  .object({
    state: z
      .string()
      .describe('active, pending, suspended, inactive, deactivated, test or unknown'),
    providerState: z.string().describe("The provider's own state name"),
    inSession: z.boolean().nullable().describe('A data session was open at the fetch'),
    openSessionBeganAt: z.string().nullable().describe('Begin of the open data session'),
    apn: z.string().nullable().describe('Access point name'),
    profileName: z.string().nullable().describe('The provider profile of the SIM'),
    lastSessionAt: z.string().nullable().describe('End of the last data session'),
    usage: z
      .object({
        bytes: z.number().describe('Bytes used this period'),
        periodEnd: z.string().nullable().describe('End of the billing period'),
        limitBytes: z.number().nullable().describe('Data limit of the period'),
      })
      .loose()
      .nullable()
      .describe('Data used this billing period'),
  })
  .loose()
  .describe('The provider status stored by the last Refresh');

const userRefSchema = z
  .object({
    id: z.string().describe('User ID'),
    name: z.string().nullable().describe('First and last name, null when not set'),
  })
  .loose();

const attachmentSummarySchema = z
  .object({
    id: z.number().describe('Attachment ID: Confirm and Detach send it back'),
    stationId: z.string().nullable().describe('The station ID, null for another target'),
    stationOcppId: z.string().nullable().describe('The OCPP identity of the station'),
    siteId: z.string().nullable().describe("The station's site"),
    siteName: z.string().nullable().describe("The station's site name"),
    paymentTerminalId: z.string().nullable().describe('Reserved for payment terminals'),
    source: z
      .enum(['reported', 'entered', 'attached', 'imported'])
      .describe(
        'reported by the station, entered on the station, attached on the SIM page, or imported',
      ),
    attachedAt: z.string().describe('When the SIM was attached'),
    confirmed: z
      .boolean()
      .describe('A person with access to every site confirmed it; until then nothing is fetched'),
    confirmedAt: z.string().nullable().describe('When it was confirmed'),
  })
  .loose()
  .describe('The open attachment');

const simFields = {
  id: z.string().describe('SIM ID'),
  iccid: z.string().describe('ICCID, normalized'),
  imsi: z.string().nullable().describe('IMSI'),
  label: z.string().nullable().describe('Operator label'),
  notes: z.string().nullable().describe('Operator notes'),
  provider: z.string().nullable().describe('The provider that has the SIM, null before a lookup'),
  providerRef: z.string().nullable().describe("The provider's SIM ID"),
  status: z
    .enum(['active', 'inactive'])
    .describe('The CSMS status (Deactivate, Reactivate), apart from the provider status'),
  deactivatedAt: z.string().nullable().describe('When the SIM was deactivated'),
  deactivatedBy: z
    .string()
    .nullable()
    .describe('The user who deactivated it; null for a user a site-restricted reader may not see'),
  lastStatus: storedStatusSchema.nullable(),
  statusFetchedAt: z.string().nullable().describe('When the provider status was fetched'),
  lastFetchedAt: z.string().nullable().describe('When the sessions were last fetched'),
  lookupMissedAt: z.string().nullable().describe('When the last lookup found no SIM'),
  lookupMissReason: z.string().nullable().describe('not_found after a lookup miss'),
  createdAt: z.string().describe('Created'),
  updatedAt: z.string().describe('Last updated'),
  attachment: attachmentSummarySchema.nullable(),
};

const simSchema = z.object(simFields).loose().describe('A SIM');

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

const simDetailSchema = z
  .object({
    ...simFields,
    deactivatedByUser: userRefSchema.nullable().describe('The user who deactivated the SIM'),
    attachedBy: userRefSchema
      .nullable()
      .describe('The person who attached, entered or imported the open attachment'),
    capabilities: capabilitiesSchema.nullable().describe('Null while the provider is off'),
    network: z
      .object({
        name: z.string().nullable().describe('Network name, null when not reported'),
        radioAccessTechnology: z
          .string()
          .nullable()
          .describe('Radio access technology, such as LTE, null when not reported'),
        cellId: z.string().nullable().describe('Cell ID, null when not reported'),
        observedAt: z.string().describe('End of the newest stored session'),
      })
      .loose()
      .nullable()
      .describe(
        'Network of the newest stored session; for a site-restricted user, of the sessions at stations of their sites',
      ),
    recentAlerts: z
      .array(
        z
          .object({
            kind: z.string().describe('The alert kind'),
            receivedAt: z.string().describe('When the provider logged the alert'),
          })
          .loose(),
      )
      .describe('The five newest stored SIM alerts; alerts arrive only with a Refresh'),
    historyDays: z.number().nullable().describe('How far back the provider keeps data'),
    reportingDelayHours: z.number().nullable().describe('How late the provider reports sessions'),
    fetchDays: z.number().describe('The Refresh period preselected'),
    retentionDays: z.number().describe('Days fetched SIM data is kept'),
    coverageTimeZone: z
      .string()
      .describe("The time zone of the coverage days: the attached station's site, else the system"),
  })
  .loose()
  .describe('A SIM with its provider data');

const createResponse = z
  .object({
    ...simFields,
    created: z
      .boolean()
      .describe('False when a SIM with this ICCID already existed: nothing changed'),
  })
  .loose();

const attachmentItemSchema = z
  .object({
    id: z.number().describe('Attachment ID'),
    stationId: z.string().nullable().describe('The station ID'),
    stationOcppId: z.string().nullable().describe('The OCPP identity of the station'),
    siteId: z.string().nullable().describe("The station's site"),
    siteName: z.string().nullable().describe("The station's site name"),
    paymentTerminalId: z.string().nullable().describe('Reserved for payment terminals'),
    source: z.string().describe('reported, entered, attached or imported'),
    attachedAt: z.string().describe('When it was attached'),
    attachedBy: userRefSchema
      .nullable()
      .describe('Who attached it; null for a station report or a user the reader may not see'),
    confirmedAt: z.string().nullable().describe('When it was confirmed'),
    confirmedBy: z
      .string()
      .nullable()
      .describe('Who confirmed it; null for a user a site-restricted reader may not see'),
    detachedAt: z.string().nullable().describe('When it was closed, null while open'),
    detachedBy: z
      .string()
      .nullable()
      .describe('Who closed it; null for a user a site-restricted reader may not see'),
    detachReason: z
      .string()
      .nullable()
      .describe('detached, iccid_changed, replaced, displaced or deactivated'),
  })
  .loose()
  .describe('One attachment of the SIM');

const confirmResponse = z
  .object({
    confirmed: z.literal(true).describe('The attachment is confirmed'),
    confirmedAt: z.string().nullable().describe('When it was confirmed'),
  })
  .loose();

const timelineResponse = z
  .object({
    items: z.array(
      z
        .object({
          at: z.string().describe('When it happened'),
          source: z.literal('sim').describe('The provider'),
          kind: z.string().describe('session, or an alert kind'),
          details: z.record(z.string(), z.unknown()).describe('Fields of the item'),
        })
        .loose(),
    ),
    ...timelinePagingResponseFields,
    from: z.string().describe('Start of the range read'),
    to: z.string().describe('End of the range read'),
    capped: z.boolean().describe('The range was shortened to 31 days or the retention'),
    lastFetchedAt: z.string().nullable().describe('When the sessions were last fetched'),
    days: z
      .array(
        z
          .object({
            date: z.string().describe('The day (YYYY-MM-DD) in the coverage time zone'),
            label: z
              .enum(['has_data', 'no_sessions', 'partial', 'pending', 'not_fetched', 'unavailable'])
              .describe('What the stored data of the day can show'),
          })
          .loose(),
      )
      .describe('What the stored SIM data of each day can show'),
  })
  .loose();

const refreshResponse = z
  .object({
    provider: z
      .object({
        result: z
          .enum(['ok', 'skipped', 'failed'])
          .describe('ok when fetched, skipped or failed otherwise'),
        reason: z
          .string()
          .optional()
          .describe('provider_off, not_found, backoff or in_progress for a skipped part'),
        kind: z.string().optional().describe('The error kind of a failed part'),
        provider: z.string().optional().describe('The SIM provider asked'),
        fetchedAt: z.string().optional().describe('When the data was fetched'),
        sessionsStored: z.number().optional().describe('Sessions stored by this Refresh'),
        alertsStored: z.number().optional().describe('Alerts stored by this Refresh'),
        retryAfter: z.number().optional().describe('Seconds to wait before the next try'),
      })
      .loose()
      .describe('The SIM provider part'),
  })
  .loose();

const resetResponse = z
  .object({ status: z.literal('accepted').describe('The provider accepted the network reset') })
  .loose();

const featureOff = errorWith('SIM features off', [ERROR_CODES.SIM_FEATURE_DISABLED]);
const simNotFound = errorWith('SIM not found', [ERROR_CODES.SIM_NOT_FOUND]);

function siteIdsOf(request: FastifyRequest): Promise<string[] | null> {
  const { userId } = request.user as JwtPayload;
  return getUserSiteIds(userId);
}

/** The person reading a reply and their sites, for the user ids a reply may name. */
async function viewerOf(request: FastifyRequest): Promise<SimViewer> {
  const { userId } = request.user as JwtPayload;
  return { userId, siteIds: await getUserSiteIds(userId) };
}

function actorOf(request: FastifyRequest): SimActor {
  const audit = getAuditActor(request);
  return { audit, userId: audit.actorUserId };
}

async function sendSimNotFound(reply: FastifyReply): Promise<void> {
  await reply.status(404).send(SIM_NOT_FOUND);
}

async function sendSimInactive(reply: FastifyReply): Promise<void> {
  await reply.status(409).send({
    error: 'This SIM is inactive. Reactivate it first',
    code: 'SIM_INACTIVE',
  });
}

async function sendAttachmentChanged(reply: FastifyReply): Promise<void> {
  await reply.status(409).send({
    error: 'The SIM attachment changed since it was shown, check it and try again',
    code: 'SIM_ATTACHMENT_CHANGED',
  });
}

/** The enabled provider with this id, or null. */
async function providerOf(id: string | null): Promise<SimProvider | null> {
  if (id == null) return null;
  return simProviderRegistry().getProvider(id as SimProviderId);
}

/** Seconds a Redis key still lives, else the fallback; a Redis failure is logged. */
async function secondsLeft(
  key: string,
  fallback: number,
  request: FastifyRequest,
): Promise<number> {
  try {
    return (await simKeyStore().ttlSeconds(key)) ?? fallback;
  } catch (err: unknown) {
    request.log.warn({ err, key }, 'SIM limit wait not read in Redis; the full wait is given');
    return fallback;
  }
}

/** Deactivate and Reactivate: all-site access, audited by the inventory service. */
async function setSimStatusRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  status: 'active' | 'inactive',
): Promise<SimView | undefined> {
  if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return undefined;
  const { id } = request.params as z.infer<typeof simParams>;
  const input = { actor: actorOf(request), log: request.log };
  const result =
    status === 'inactive' ? await deactivateSim(id, input) : await reactivateSim(id, input);
  const view = result.kind === 'not_found' ? null : await simViewById(id, await viewerOf(request));
  if (view == null) {
    await sendSimNotFound(reply);
    return undefined;
  }
  return view;
}

export function simRoutes(app: FastifyInstance): void {
  app.get(
    '/sims',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'List SIMs',
        description:
          'The SIM inventory, newest first. A user with access to every site sees every SIM; a site-restricted user sees only SIMs with a confirmed attachment to a station of their sites. Reads the database only.',
        operationId: 'listSims',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: { 200: paginatedResponse(simSchema), 400: featureOff },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof listQuery>;
      return listSimViews(
        {
          ...(query.search != null ? { search: query.search } : {}),
          ...(query.provider != null ? { provider: query.provider } : {}),
          ...(query.attachment != null ? { attachment: query.attachment } : {}),
          ...(query.status != null ? { status: query.status } : {}),
          ...(query.state != null ? { state: query.state } : {}),
          ...(query.stationId != null ? { stationId: query.stationId } : {}),
        },
        await viewerOf(request),
        query.page,
        query.limit,
      );
    },
  );

  app.post(
    '/sims',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      preValidation: [rejectUnknownBodyKeys(createBody)],
      schema: {
        tags: ['SIMs'],
        summary: 'Add a SIM',
        description:
          'Adds a SIM to the inventory, unattached. Needs access to every site, since an unattached SIM belongs to no site. A SIM with the same ICCID (normalized) answers 200 with created false and is not changed. Calls no provider.',
        operationId: 'createSim',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createBody),
        response: {
          200: itemResponse(createResponse),
          201: itemResponse(createResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: simNotFound,
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return;
      const body = parseZodRequest(createBody, request.body);
      if (!isValidIccid(body.iccid)) {
        await reply.status(400).send({
          error: 'The ICCID must be 19 digits with an optional trailing F, or 20 digits',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      // One insert with the fields and one `created` audit row; an existing SIM,
      // also one a parallel request created first, is returned unchanged.
      const { sim, created } = await ensureSim(body.iccid, {
        actor: actorOf(request),
        log: request.log,
        fields: {
          ...(body.imsi != null ? { imsi: body.imsi } : {}),
          ...(body.label != null ? { label: body.label } : {}),
          ...(body.notes != null ? { notes: body.notes } : {}),
        },
      });
      const view = await simViewById(sim.id, await viewerOf(request));
      if (view == null) {
        await sendSimNotFound(reply);
        return;
      }
      return reply.status(created ? 201 : 200).send({ ...view, created });
    },
  );

  app.get(
    '/sims/export',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Export SIMs as CSV',
        description:
          'Exports every SIM matching the list filters (search, provider, attachment, status, state, stationId) that the user sees, newest first; with no filter every SIM the user sees. A site-restricted user gets only SIMs with a confirmed attachment to a station of their sites. page and limit are ignored. Columns: iccid, imsi, label, notes, stationId (OCPP identity of the attached station), status (CSMS status), provider, providerState (provider status of the last Refresh), attachedStationId, attachmentConfirmed. Reads the database only.',
        operationId: 'exportSims',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: { 400: featureOff },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof listQuery>;
      const csv = await exportSimsCsv(
        {
          ...(query.search != null ? { search: query.search } : {}),
          ...(query.provider != null ? { provider: query.provider } : {}),
          ...(query.attachment != null ? { attachment: query.attachment } : {}),
          ...(query.status != null ? { status: query.status } : {}),
          ...(query.state != null ? { state: query.state } : {}),
          ...(query.stationId != null ? { stationId: query.stationId } : {}),
        },
        await siteIdsOf(request),
      );
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename=sims.csv')
        .send(csv);
    },
  );

  app.get(
    '/sims/export/template',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Download the SIM import CSV template',
        description:
          'The CSV header and example rows. Needs access to every site, as the import does. The import reads iccid, imsi, label, notes and stationId; the other columns are filled by the export only.',
        operationId: 'exportSimTemplate',
        security: [{ bearerAuth: [] }],
        response: { 400: featureOff, 404: simNotFound },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return;
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename=sims-template.csv')
        .send(exportSimTemplateCsv());
    },
  );

  app.post(
    '/sims/import',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      // 10000 rows at the widest cells exceed the default 1 MB body limit.
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        tags: ['SIMs'],
        summary: 'Import SIMs from parsed CSV rows',
        description:
          'Creates SIMs by ICCID (normalized) and attaches each row with a stationId (OCPP identity) to that station, confirmed (source imported). Needs access to every site; rows with a stationId also need stations:write (403 INSUFFICIENT_PERMISSIONS). An existing SIM is updated (IMSI, label, notes; an empty cell keeps the field) only with updateExisting, else skipped. A row with an invalid ICCID or IMSI, an unknown station, a station with another SIM, a SIM attached elsewhere or an inactive SIM is refused in errors and changes nothing; nothing is detached. One transaction, audited (notes CSV import). Calls no provider.',
        operationId: 'importSims',
        security: [{ bearerAuth: [] }],
        body: zodSchema(importBody),
        response: {
          200: zodSchema(importResultResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('Station rows without stations:write', [
            ERROR_CODES.INSUFFICIENT_PERMISSIONS,
          ]),
          404: simNotFound,
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return;
      const { rows, updateExisting } = request.body as z.infer<typeof importBody>;
      // Station rows attach SIMs: the attach route needs stations:write too.
      if (
        rows.some((row) => row.stationId != null && row.stationId.trim() !== '') &&
        !(await requestHasPermission(request, 'stations:write'))
      ) {
        await reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
        return;
      }
      return importSimsCsv(rows, updateExisting, actorOf(request), request.log);
    },
  );

  app.get(
    '/sims/:id',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Get a SIM',
        description:
          'The SIM, its open attachment, and the provider status, network and alerts stored by the last Refresh. Reads the database only: no provider call.',
        operationId: 'getSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        response: { 200: itemResponse(simDetailSchema), 400: featureOff, 404: simNotFound },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof simParams>;
      const detail = await simDetailView(id, await viewerOf(request), RECENT_ALERTS);
      if (detail == null) {
        await sendSimNotFound(reply);
        return;
      }
      const simSettings = await readSimSettings();
      const registry = simProviderRegistry();
      const provider = await providerOf(detail.provider);
      return {
        ...detail,
        capabilities: provider?.capabilities ?? null,
        historyDays: provider?.historyDays ?? (await simHistoryDays(registry)),
        reportingDelayHours: provider?.reportingDelayHours ?? null,
        fetchDays: simSettings.fetchDays,
        retentionDays: simSettings.retentionDays,
        coverageTimeZone: detail.siteTimezone ?? (await getSystemTimezone()),
      };
    },
  );

  app.patch(
    '/sims/:id',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      preValidation: [rejectUnknownBodyKeys(updateBody)],
      schema: {
        tags: ['SIMs'],
        summary: 'Update a SIM',
        description:
          'Changes the label, notes and IMSI of a SIM. The ICCID never changes. Audited when a field changed.',
        operationId: 'updateSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        body: zodSchema(updateBody),
        response: {
          200: itemResponse(simSchema),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: simNotFound,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof simParams>;
      if ((await visibleSim(id, await siteIdsOf(request))) == null) {
        await sendSimNotFound(reply);
        return;
      }
      const body = request.body as z.infer<typeof updateBody>;
      const result = await updateSim(
        id,
        {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.imsi !== undefined ? { imsi: body.imsi } : {}),
        },
        { actor: actorOf(request), log: request.log },
      );
      const view = result == null ? null : await simViewById(id, await viewerOf(request));
      if (view == null) {
        await sendSimNotFound(reply);
        return;
      }
      return view;
    },
  );

  app.delete(
    '/sims/:id',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Delete a SIM',
        description:
          'Deletes a SIM with its attachment history and its stored sessions, alerts and fetched periods. Needs access to every site. Refused while the SIM is attached.',
        operationId: 'deleteSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        response: {
          200: successResponse,
          400: featureOff,
          404: simNotFound,
          409: errorWith('Attached', [ERROR_CODES.SIM_ATTACHED]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof simParams>;
      const result = await deleteSim(id, { actor: actorOf(request), log: request.log });
      if (result.kind === 'not_found') {
        await sendSimNotFound(reply);
        return;
      }
      if (result.kind === 'attached') {
        await reply.status(409).send({
          error: 'Detach the SIM before deleting it',
          code: 'SIM_ATTACHED',
        });
        return;
      }
      return { success: true as const };
    },
  );

  app.post(
    '/sims/:id/deactivate',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Deactivate a SIM',
        description:
          'Sets the CSMS status of the SIM to inactive and closes its open attachment. The SIM is kept, the provider status is not touched and no provider is called. An inactive SIM cannot be attached, refreshed or reset. Needs access to every site. An inactive SIM stays as it is.',
        operationId: 'deactivateSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        response: { 200: itemResponse(simSchema), 400: featureOff, 404: simNotFound },
      },
    },
    async (request, reply) => setSimStatusRoute(request, reply, 'inactive'),
  );

  app.post(
    '/sims/:id/reactivate',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Reactivate a SIM',
        description:
          'Sets the CSMS status of the SIM to active again. No attachment is opened and no provider is called. Needs access to every site. An active SIM stays as it is.',
        operationId: 'reactivateSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        response: { 200: itemResponse(simSchema), 400: featureOff, 404: simNotFound },
      },
    },
    async (request, reply) => setSimStatusRoute(request, reply, 'active'),
  );

  app.get(
    '/sims/:id/attachments',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: "List a SIM's attachments",
        description:
          'Where the SIM sat, newest first, open and closed. A site-restricted user sees only the attachments to stations of their sites.',
        operationId: 'listSimAttachments',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        querystring: zodSchema(paginationQuery.omit({ search: true })),
        response: {
          200: paginatedResponse(attachmentItemSchema),
          400: featureOff,
          404: simNotFound,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof simParams>;
      const { page, limit } = request.query as { page: number; limit: number };
      const viewer = await viewerOf(request);
      if ((await visibleSim(id, viewer.siteIds)) == null) {
        await sendSimNotFound(reply);
        return;
      }
      return simAttachmentHistory(id, viewer, page, limit);
    },
  );

  app.post(
    '/sims/:id/attachments',
    {
      onRequest: [authorize('sims:write', 'stations:write'), simFeatureOnRequest],
      preValidation: [rejectUnknownBodyKeys(attachBody)],
      schema: {
        tags: ['SIMs'],
        summary: 'Attach a SIM to a station',
        description:
          'Attaches the SIM to a station, confirmed at once. Needs access to every site. Refused for a station that has a SIM, a SIM attached elsewhere and an inactive SIM; nothing is closed. Calls no provider.',
        operationId: 'attachSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        body: zodSchema(attachBody),
        response: {
          200: itemResponse(attachmentItemSchema),
          400: featureOff,
          404: errorWith('Not found', [ERROR_CODES.SIM_NOT_FOUND, ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Not attached', [
            ERROR_CODES.STATION_HAS_SIM,
            ERROR_CODES.SIM_ATTACHED_ELSEWHERE,
            ERROR_CODES.SIM_INACTIVE,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof simParams>;
      const { stationId } = request.body as z.infer<typeof attachBody>;
      if ((await stationForAttach(stationId)) == null) {
        await reply.status(404).send(STATION_NOT_FOUND);
        return;
      }
      const result = await attachSim(id, stationId, {
        actor: actorOf(request),
        log: request.log,
      });
      switch (result.kind) {
        case 'sim_not_found':
          await sendSimNotFound(reply);
          return;
        case 'sim_inactive':
          await sendSimInactive(reply);
          return;
        case 'station_has_sim':
          await reply.status(409).send({
            error: 'The station already has a SIM; detach it first',
            code: 'STATION_HAS_SIM',
          });
          return;
        case 'sim_attached_elsewhere':
          await reply.status(409).send({
            error: 'The SIM is attached elsewhere; detach it first',
            code: 'SIM_ATTACHED_ELSEWHERE',
          });
          return;
        case 'attached':
        case 'unchanged': {
          const view = await attachmentViewById(result.attachment.id, await viewerOf(request));
          if (view == null) {
            await sendSimNotFound(reply);
            return;
          }
          return view;
        }
      }
    },
  );

  app.post(
    '/sims/:id/attachments/:attachmentId/detach',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: 'Detach a SIM',
        description:
          "Closes the SIM's open attachment the person saw. A site-restricted user may detach a SIM from a station of their sites; the SIM then leaves their view. Stored data stays with the SIM.",
        operationId: 'detachSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentParams),
        response: {
          200: itemResponse(attachmentItemSchema),
          400: featureOff,
          404: simNotFound,
          409: errorWith('Attachment changed', [ERROR_CODES.SIM_ATTACHMENT_CHANGED]),
        },
      },
    },
    async (request, reply) => {
      const { id, attachmentId } = request.params as z.infer<typeof attachmentParams>;
      const siteIds = await siteIdsOf(request);
      if ((await visibleSim(id, siteIds)) == null) {
        await sendSimNotFound(reply);
        return;
      }
      const open = await openSimAttachment(id);
      if (open?.id !== attachmentId) {
        await sendAttachmentChanged(reply);
        return;
      }
      // The attachment's station must be one the user may reach (a terminal
      // attachment has no station: all-site users only).
      if (siteIds != null) {
        const { userId } = request.user as JwtPayload;
        if (open.stationId == null || !(await checkStationSiteAccess(open.stationId, userId))) {
          await sendSimNotFound(reply);
          return;
        }
      }
      const closed = await detachSimAttachment(id, attachmentId, {
        actor: actorOf(request),
        log: request.log,
      });
      if (closed == null) {
        await sendAttachmentChanged(reply);
        return;
      }
      const view = await attachmentViewById(closed.id, await viewerOf(request));
      if (view == null) {
        await sendSimNotFound(reply);
        return;
      }
      return view;
    },
  );

  app.post(
    '/sims/:id/attachments/:attachmentId/confirm',
    {
      onRequest: [authorize('sims:write', 'stations:write'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: "Confirm a SIM's attachment",
        description:
          'Confirms that the SIM is the SIM in the attached station (Confirm SIM on the SIM page). Needs access to every site. Makes no provider call. An attachment closed or replaced since it was shown answers 409 SIM_ATTACHMENT_CHANGED; a confirmed one stays as it is.',
        operationId: 'confirmSimAttachment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(attachmentParams),
        response: {
          200: itemResponse(confirmResponse),
          400: featureOff,
          404: simNotFound,
          409: errorWith('Not confirmed', [
            ERROR_CODES.SIM_ATTACHMENT_CHANGED,
            ERROR_CODES.SIM_INACTIVE,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SIM_NOT_FOUND))) return;
      const { id, attachmentId } = request.params as z.infer<typeof attachmentParams>;
      if ((await visibleSim(id, null)) == null) {
        await sendSimNotFound(reply);
        return;
      }
      const open = await openSimAttachment(id);
      if (open?.id !== attachmentId || open.stationId == null) {
        await sendAttachmentChanged(reply);
        return;
      }
      const result = await confirmStationAttachment(open.stationId, attachmentId, {
        actor: actorOf(request),
        log: request.log,
      });
      if (result === 'sim_inactive') {
        await sendSimInactive(reply);
        return;
      }
      if (result === 'not_attached' || result === 'attachment_changed') {
        await sendAttachmentChanged(reply);
        return;
      }
      const confirmed = await openSimAttachment(id);
      return {
        confirmed: true as const,
        confirmedAt: confirmed?.confirmedAt?.toISOString() ?? null,
      };
    },
  );

  app.get(
    '/sims/:id/timeline',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: "Get a SIM's timeline",
        description:
          "The SIM's stored sessions and alerts, newest first, plus what each day of the range has stored. Paged by page number (page, limit, total) or by cursor. Reads the database only. No OCPP connection events: the SIM may have sat in several stations. The range is at most 31 days and within the SIM retention; a longer one is shortened (capped).",
        operationId: 'getSimTimeline',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        querystring: zodSchema(timelineQuery),
        response: {
          200: itemResponse(timelineResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: simNotFound,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof simParams>;
      const query = request.query as z.infer<typeof timelineQuery>;
      const viewer = await viewerOf(request);
      const detail = await simDetailView(id, viewer, 0);
      if (detail == null) {
        await sendSimNotFound(reply);
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
      const paging = timelinePaging(query, SIM_TIMELINE_RANK);
      if ('error' in paging) {
        await reply.status(400).send({ error: paging.error, code: 'VALIDATION_ERROR' });
        return;
      }
      const simSettings = await readSimSettings();
      const earliest = Math.max(
        to.getTime() - SIM_RANGE_MAX_DAYS * DAY_MS,
        now.getTime() - simSettings.retentionDays * DAY_MS,
      );
      const capped = from.getTime() < earliest;
      const rangeFrom = capped ? new Date(earliest) : from;
      if (rangeFrom.getTime() >= to.getTime()) {
        await reply.status(400).send({
          error: 'The timeline end is older than the kept SIM data',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      // A site-restricted user sees only the SIM's periods at stations of their sites.
      const windows = await simSiteWindows(id, viewer.siteIds);
      const page = await simTimelinePage(id, { from: rangeFrom, to }, paging, windows);
      const provider = await providerOf(detail.provider);
      const days = await simCoveredDays(
        id,
        rangeFrom,
        to,
        detail.siteTimezone ?? (await getSystemTimezone()),
        {
          historyDays: provider?.historyDays ?? (await simHistoryDays(simProviderRegistry())),
          retentionDays: simSettings.retentionDays,
          reportingDelayHours: provider?.reportingDelayHours ?? 0,
          ...(windows != null ? { windows } : {}),
        },
        now,
      );
      return {
        ...page,
        from: rangeFrom.toISOString(),
        to: to.toISOString(),
        capped,
        lastFetchedAt: detail.lastFetchedAt,
        days,
      };
    },
  );

  app.post(
    '/sims/:id/refresh',
    {
      onRequest: [authorize('sims:read'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: "Refresh a SIM's data",
        description:
          'Fetches the SIM status, sessions and alerts from the provider for the last days (1, 3, 7, 14 or 31, default sim.sessions.fetchDays) or a date range of at most 31 days, and stores them. A user with access to every site may refresh any SIM, attached or not, confirmed or not. Sends no OCPP command. The reply is 200 whenever the request was valid; the provider part reports its own result. At most 6 a minute per SIM.',
        operationId: 'refreshSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        body: zodSchema(refreshBody),
        response: {
          200: itemResponse(refreshResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: simNotFound,
          409: errorWith('Inactive', [ERROR_CODES.SIM_INACTIVE]),
          429: errorWith('Too many Refreshes', [ERROR_CODES.SIM_PROVIDER_RATE_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof simParams>;
      const body = (request.body ?? {}) as z.infer<typeof refreshBody>;
      const sim = await visibleSim(id, await siteIdsOf(request));
      if (sim == null) {
        await sendSimNotFound(reply);
        return;
      }
      if (sim.status !== 'active') {
        await sendSimInactive(reply);
        return;
      }
      const simSettings = await readSimSettings();
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
      const limitKey = SIM_KEYS.refresh(id);
      let count: number | null = null;
      try {
        count = await keys.increment(limitKey, 60);
      } catch (err: unknown) {
        request.log.warn({ err, simId: id }, 'SIM Refresh limit not counted; Refresh allowed');
      }
      if (count != null && count > SIM_PAGE_REFRESH_LIMIT_PER_MINUTE) {
        // Over the limit stays refused even when the wait cannot be read.
        const retryAfter = await secondsLeft(limitKey, 60, request);
        await reply.status(429).header('Retry-After', String(retryAfter)).send({
          error: 'Too many Refreshes of this SIM, try again later',
          code: 'SIM_PROVIDER_RATE_LIMITED',
          retryAfter,
        });
        return;
      }

      const provider = await refreshSimProvider(
        { registry, keys, actor: getAuditActor(request), log: request.log },
        id,
        period,
        body.retryLookup === true ? { retryLookup: true } : {},
      );
      if (provider.result === 'skipped' && provider.reason === 'sim_inactive') {
        await sendSimInactive(reply);
        return;
      }
      return { provider };
    },
  );

  app.post(
    '/sims/:id/network-reset',
    {
      onRequest: [authorize('sims:write'), simFeatureOnRequest],
      schema: {
        tags: ['SIMs'],
        summary: "Reset a SIM's network",
        description:
          'Asks the SIM provider to detach the SIM from the network, so the device loses its data session and reconnects. A site-restricted user needs a confirmed attachment of the SIM to a station of their sites. One reset per SIM a minute, shared with the station route.',
        operationId: 'resetSimNetwork',
        security: [{ bearerAuth: [] }],
        params: zodSchema(simParams),
        response: {
          200: itemResponse(resetResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.SIM_FEATURE_DISABLED,
            ERROR_CODES.SIM_PROVIDER_NOT_CONFIGURED,
          ]),
          404: simNotFound,
          409: errorWith('Reset not possible', [
            ERROR_CODES.SIM_INACTIVE,
            ERROR_CODES.SIM_ACTION_UNSUPPORTED,
          ]),
          429: errorWith('Reset cooldown', [ERROR_CODES.SIM_PROVIDER_RATE_LIMITED]),
          502: errorWith('Provider request failed', [ERROR_CODES.SIM_PROVIDER_ERROR]),
          503: errorWith('Cooldown not checked', [ERROR_CODES.SIM_RESET_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof simParams>;
      const siteIds = await siteIdsOf(request);
      if ((await visibleSim(id, siteIds)) == null) {
        await sendSimNotFound(reply);
        return;
      }
      const registry = simProviderRegistry();
      if ((await registry.enabledProviders()).length === 0) {
        await reply.status(400).send({
          error: 'No SIM provider is configured',
          code: 'SIM_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      const actor = getAuditActor(request);
      const outcome = await resetSimNetwork(
        { registry, keys: simKeyStore(), actor, log: request.log },
        id,
        {
          // A site-restricted user may reset only while the SIM sits confirmed at
          // a station of their sites, also once the cooldown is taken.
          ...(siteIds != null
            ? { stillAllowed: async () => (await visibleSim(id, siteIds)) != null }
            : {}),
          // A reset of a SIM attached to a station is also a command on that station.
          onOutcome: async (result, attachedStationId) => {
            if (attachedStationId == null) return;
            await recordStationCommandAudit(
              {
                stationId: attachedStationId,
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
          await sendSimNotFound(reply);
          return;
        case 'sim_inactive':
          await sendSimInactive(reply);
          return;
        case 'not_looked_up':
          await reply.status(404).send({
            error: 'No provider SIM is known for this SIM yet; Refresh it first',
            code: 'SIM_NOT_FOUND',
          });
          return;
        case 'provider_off':
          await reply.status(400).send({
            error: 'The provider of this SIM is turned off',
            code: 'SIM_PROVIDER_NOT_CONFIGURED',
          });
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
            error: 'The network reset cannot be started right now, try again in a minute',
            code: 'SIM_RESET_UNAVAILABLE',
          });
          return;
        case 'provider_error': {
          const err = outcome.error;
          if (err.kind === 'unsupported') {
            await reply.status(409).send({
              error: 'The SIM provider refused a network reset for this SIM',
              code: 'SIM_ACTION_UNSUPPORTED',
            });
            return;
          }
          if (err.kind === 'not_found') {
            await reply.status(404).send({
              error: 'The SIM provider no longer has this SIM; Refresh it to look it up again',
              code: 'SIM_NOT_FOUND',
            });
            return;
          }
          await sendSimProviderError(err, reply);
          return;
        }
      }
    },
  );
}
