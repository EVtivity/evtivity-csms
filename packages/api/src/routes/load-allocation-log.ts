// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  evses,
  isOperatorStation,
  loadAllocationEntries,
  loadAllocationLog,
  panels,
  sessionTariffSegments,
  stationUnits,
  tariffs,
  transformers,
} from '@evtivity/database';
import { LOAD_ALLOCATION_REASONS } from '@evtivity/lib/load-allocation-reasons';
import { buildCsv } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { ID_PARAMS } from '../lib/id-validation.js';

// The load allocation log: every limit load management sent, read per site.

export const LOAD_ALLOCATION_MAX_RANGE_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = DAY_MS;
/** A reply still missing this long after the send is shown as no reply. */
export const ALLOCATION_NO_REPLY_AFTER_MS = 2 * 60 * 1000;
const EXPORT_PAGE_ROWS = 5000;
/** The most chart points one series request returns. */
export const ALLOCATION_SERIES_MAX_POINTS = 50_000;

const siteParams = z.object({ id: ID_PARAMS.siteId.describe('Site ID') });

const rangeFields = {
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Start of the range (ISO 8601, inclusive); default 24 hours before to'),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('End of the range (ISO 8601, exclusive); default now'),
};

const rangeQuery = z.object(rangeFields);

const listQuery = z.object({
  ...rangeFields,
  stationId: ID_PARAMS.stationId.optional().describe('Only the rows of this station (database ID)'),
  evseNumber: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only the rows of this OCPP EVSE number'),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe('The nextCursor of the previous page (newest first)'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe('Rows per page, 1 to 500'),
});

const REPLY_STATES = ['accepted', 'rejected', 'not_sent', 'no_reply', 'pending'] as const;
type ReplyState = (typeof REPLY_STATES)[number];

const entryItem = z
  .object({
    id: z.string().describe('Allocation entry ID'),
    createdAt: z.string().describe('When the limit was sent'),
    kind: z
      .enum(['change', 'refresh', 'credit'])
      .describe(
        'change: the allocation changed; refresh: the periodic resend; credit: a credit profile resend',
      ),
    stationId: z
      .string()
      .nullable()
      .describe('Station database ID (null when the station was deleted)'),
    stationOcppId: z.string().describe('OCPP station identifier at send time'),
    unitId: z.string().nullable().describe('Station Unit of the EVSE, if any'),
    unitName: z.string().nullable().describe('Unit name at send time'),
    evseNumber: z.number().nullable().describe('OCPP EVSE number (null for a station limit)'),
    scope: z.enum(['station', 'evse']).describe('station: the station limit; evse: one EVSE limit'),
    mode: z.enum(['station', 'evse']).describe('The balancing mode the station was in'),
    limitKw: z.number().describe('Limit sent, in kW'),
    limitA: z.number().nullable().describe('Limit sent in A per phase, when sent in A'),
    phases: z.number().nullable().describe('Phases the limit applies to (AC)'),
    rateUnit: z.enum(['A', 'W']).describe('Charging rate unit of the profile'),
    reason: z.enum(LOAD_ALLOCATION_REASONS).describe('What set this limit'),
    sessionId: z
      .string()
      .nullable()
      .describe('Session the EVSE limit was for (needs sessions:read)'),
    tariffId: z.string().nullable().describe('Tariff in force (needs pricing:read)'),
    tariffName: z.string().nullable().describe('Tariff name (needs pricing:read)'),
    tariffMaxCurrentA: z.number().nullable().describe('Tariff current limit in force, in A'),
    profileId: z.number().describe('Charging profile ID'),
    stackLevel: z.number().describe('Charging profile stack level'),
    purpose: z.string().describe('Charging profile purpose'),
    reply: z.enum(['accepted', 'rejected', 'not_sent']).nullable().describe('Station reply'),
    replyState: z
      .enum(REPLY_STATES)
      .describe('The reply, or no_reply when none came within 2 minutes, pending before that'),
    repliedAt: z.string().nullable().describe('When the reply was stored'),
    refresh: z.boolean().describe('True for the periodic resend of an unchanged limit'),
  })
  .loose();

const listResponse = z
  .object({
    data: z.array(entryItem).describe('Rows, newest first'),
    nextCursor: z.string().nullable().describe('Cursor of the next page, null on the last page'),
  })
  .loose();

const seriesPoint = z
  .object({
    t: z.string().describe('Send time; the step holds until the next point'),
    limitKw: z.number().describe('Limit sent, in kW'),
    reason: z.enum(LOAD_ALLOCATION_REASONS).describe('What set this limit'),
    reply: z.enum(REPLY_STATES).describe('Reply state of the send'),
  })
  .loose();

const seriesResponse = z
  .object({
    series: z
      .array(
        z
          .object({
            key: z.string().describe('station:<id> or evse:<id>:<number>'),
            scope: z.enum(['station', 'evse']).describe('Station limit or EVSE limit'),
            stationId: z.string().nullable().describe('Station database ID'),
            stationOcppId: z.string().describe('OCPP station identifier'),
            unitName: z.string().nullable().describe('Unit name of the EVSE'),
            evseNumber: z.number().nullable().describe('OCPP EVSE number'),
            points: z.array(seriesPoint).describe('Step points, oldest first'),
          })
          .loose(),
      )
      .describe('One step series per station and per EVSE limited on its own'),
    references: z
      .object({
        siteLimitKw: z
          .number()
          .nullable()
          .describe('Site limit of the newest allocation in the range'),
        panels: z
          .array(z.object({ id: z.string(), name: z.string(), kw: z.number() }).loose())
          .describe('Panel capacities now'),
        transformers: z
          .array(z.object({ id: z.string(), name: z.string(), kw: z.number() }).loose())
          .describe('Transformer capacities now'),
      })
      .loose(),
    truncated: z
      .boolean()
      .describe('True when the range held more points than one response returns'),
  })
  .loose();

const timelineResponse = z
  .object({
    parts: z
      .array(
        z
          .object({
            sessionId: z.string().describe('Session ID'),
            stationId: z.string().describe('Station database ID'),
            stationOcppId: z.string().describe('OCPP station identifier'),
            evseNumber: z.number().nullable().describe('OCPP EVSE number'),
            unitName: z.string().nullable().describe('Unit name of the EVSE'),
            from: z.string().describe('Start of this part (session start or tariff switch)'),
            to: z.string().nullable().describe('End of this part, null while running'),
            tariffName: z.string().nullable().describe('Tariff of this part (needs pricing:read)'),
            maxCurrentA: z.number().nullable().describe('Tariff current limit of this part, in A'),
          })
          .loose(),
      )
      .describe('Each session of the site in the range, split at its tariff segments'),
  })
  .loose();

const RANGE_ERRORS = errorWith('Invalid or too long range', [
  ERROR_CODES.VALIDATION_ERROR,
  ERROR_CODES.LOAD_ALLOCATION_RANGE_TOO_LONG,
]);
const SITE_NOT_FOUND = errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]);

interface Range {
  from: Date;
  to: Date;
}

/** The query range, or a reply already sent for a bad one. */
async function readRange(
  query: { from?: string | undefined; to?: string | undefined },
  reply: FastifyReply,
): Promise<Range | null> {
  const to = query.to != null ? new Date(query.to) : new Date();
  const from =
    query.from != null ? new Date(query.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (from.getTime() >= to.getTime()) {
    await reply
      .status(400)
      .send({ error: 'from must be before to', code: 'VALIDATION_ERROR', field: 'from' });
    return null;
  }
  if (to.getTime() - from.getTime() > LOAD_ALLOCATION_MAX_RANGE_DAYS * DAY_MS) {
    await reply.status(400).send({
      error: `The range is longer than ${String(LOAD_ALLOCATION_MAX_RANGE_DAYS)} days`,
      code: 'LOAD_ALLOCATION_RANGE_TOO_LONG',
    });
    return null;
  }
  return { from, to };
}

/** The URL site when the caller may see it, else replies 404. */
async function siteOfRequest(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const { id } = request.params as { id: string };
  const { userId } = request.user as { userId: string };
  if (!siteInScope(await getUserSiteIds(userId), id)) {
    await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
    return null;
  }
  return id;
}

interface Masks {
  sessions: boolean;
  pricing: boolean;
}

async function readMasks(request: FastifyRequest): Promise<Masks> {
  const [sessions, pricing] = await Promise.all([
    requestHasPermission(request, 'sessions:read'),
    requestHasPermission(request, 'pricing:read'),
  ]);
  return { sessions, pricing };
}

export function replyStateOf(
  reply: string | null,
  sentAt: Date,
  now: number = Date.now(),
): ReplyState {
  if (reply === 'accepted' || reply === 'rejected' || reply === 'not_sent') return reply;
  return now - sentAt.getTime() > ALLOCATION_NO_REPLY_AFTER_MS ? 'no_reply' : 'pending';
}

export function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(`${createdAt.toISOString()}|${String(id)}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: number } | null {
  const [iso, idText] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (iso == null || idText == null || !/^\d{1,18}$/.test(idText)) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: Number(idText) };
}

function numberOrNull(value: string | null): number | null {
  return value == null ? null : Number(value);
}

const entryColumns = {
  id: loadAllocationEntries.id,
  createdAt: loadAllocationEntries.createdAt,
  kind: loadAllocationLog.kind,
  stationId: loadAllocationEntries.stationId,
  stationOcppId: loadAllocationEntries.stationOcppId,
  unitId: loadAllocationEntries.unitId,
  unitName: loadAllocationEntries.unitName,
  evseNumber: loadAllocationEntries.evseNumber,
  scope: loadAllocationEntries.scope,
  mode: loadAllocationEntries.mode,
  limitKw: loadAllocationEntries.limitKw,
  limitA: loadAllocationEntries.limitA,
  phases: loadAllocationEntries.phases,
  rateUnit: loadAllocationEntries.rateUnit,
  reason: loadAllocationEntries.reason,
  sessionId: loadAllocationEntries.sessionId,
  tariffId: loadAllocationEntries.tariffId,
  tariffName: tariffs.name,
  tariffMaxCurrentA: loadAllocationEntries.tariffMaxCurrentA,
  profileId: loadAllocationEntries.profileId,
  stackLevel: loadAllocationEntries.stackLevel,
  purpose: loadAllocationEntries.purpose,
  reply: loadAllocationEntries.reply,
  repliedAt: loadAllocationEntries.repliedAt,
  refresh: loadAllocationEntries.refresh,
};

type EntryRow = Awaited<ReturnType<typeof selectEntries>>[number];

function selectEntries(where: SQL | undefined, order: 'asc' | 'desc', limit: number) {
  const dir = order === 'asc' ? asc : desc;
  return db
    .select(entryColumns)
    .from(loadAllocationEntries)
    .innerJoin(loadAllocationLog, eq(loadAllocationLog.id, loadAllocationEntries.logId))
    .leftJoin(tariffs, eq(tariffs.id, loadAllocationEntries.tariffId))
    .where(where)
    .orderBy(dir(loadAllocationEntries.createdAt), dir(loadAllocationEntries.id))
    .limit(limit);
}

function entryView(row: EntryRow, masks: Masks, now: number): Record<string, unknown> {
  return {
    id: String(row.id),
    createdAt: row.createdAt.toISOString(),
    kind: row.kind,
    stationId: row.stationId,
    stationOcppId: row.stationOcppId,
    unitId: row.unitId,
    unitName: row.unitName,
    evseNumber: row.evseNumber,
    scope: row.scope,
    mode: row.mode,
    limitKw: Number(row.limitKw),
    limitA: numberOrNull(row.limitA),
    phases: row.phases,
    rateUnit: row.rateUnit,
    reason: row.reason,
    sessionId: masks.sessions ? row.sessionId : null,
    tariffId: masks.pricing ? row.tariffId : null,
    tariffName: masks.pricing ? row.tariffName : null,
    tariffMaxCurrentA: numberOrNull(row.tariffMaxCurrentA),
    profileId: row.profileId,
    stackLevel: row.stackLevel,
    purpose: row.purpose,
    reply: row.reply,
    replyState: replyStateOf(row.reply, row.createdAt, now),
    repliedAt: row.repliedAt?.toISOString() ?? null,
    refresh: row.refresh,
  };
}

function rangeWhere(siteId: string, range: Range): SQL {
  return and(
    eq(loadAllocationEntries.siteId, siteId),
    gte(loadAllocationEntries.createdAt, range.from),
    lt(loadAllocationEntries.createdAt, range.to),
  ) as SQL;
}

export const LOAD_ALLOCATION_EXPORT_COLUMNS = [
  'time',
  'station',
  'unit',
  'evse',
  'scope',
  'mode',
  'limitKw',
  'limitA',
  'phases',
  'rateUnit',
  'reason',
  'session',
  'tariff',
  'tariffCurrentLimitA',
  'profileId',
  'stackLevel',
  'purpose',
  'reply',
  'repliedAt',
  'refresh',
];

function csvRow(view: Record<string, unknown>): unknown[] {
  return [
    view['createdAt'],
    view['stationOcppId'],
    view['unitName'],
    view['evseNumber'],
    view['scope'],
    view['mode'],
    view['limitKw'],
    view['limitA'],
    view['phases'],
    view['rateUnit'],
    view['reason'],
    view['sessionId'],
    view['tariffName'],
    view['tariffMaxCurrentA'],
    view['profileId'],
    view['stackLevel'],
    view['purpose'],
    view['replyState'],
    view['repliedAt'],
    view['refresh'],
  ];
}

function fileDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SeriesPointView {
  t: string;
  limitKw: number;
  reason: string;
  reply: ReplyState;
}

export interface SeriesView {
  key: string;
  scope: 'station' | 'evse';
  stationId: string | null;
  stationOcppId: string;
  unitName: string | null;
  evseNumber: number | null;
  points: SeriesPointView[];
}

/** Groups entry rows (oldest first) into one step series per station and per EVSE. */
export function buildAllocationSeries(
  rows: readonly {
    createdAt: Date;
    stationId: string | null;
    stationOcppId: string;
    unitName: string | null;
    evseNumber: number | null;
    scope: string;
    limitKw: string;
    reason: string;
    reply: string | null;
  }[],
  now: number = Date.now(),
): SeriesView[] {
  const byKey = new Map<string, SeriesView>();
  for (const row of rows) {
    const station = row.stationId ?? `ocpp:${row.stationOcppId}`;
    const evse = row.scope === 'evse' && row.evseNumber != null;
    const key = evse ? `evse:${station}:${String(row.evseNumber)}` : `station:${station}`;
    let series = byKey.get(key);
    if (series == null) {
      series = {
        key,
        scope: evse ? 'evse' : 'station',
        stationId: row.stationId,
        stationOcppId: row.stationOcppId,
        unitName: evse ? row.unitName : null,
        evseNumber: evse ? row.evseNumber : null,
        points: [],
      };
      byKey.set(key, series);
    }
    series.unitName = evse ? row.unitName : null;
    series.points.push({
      t: row.createdAt.toISOString(),
      limitKw: Number(row.limitKw),
      reason: row.reason,
      reply: replyStateOf(row.reply, row.createdAt, now),
    });
  }
  return [...byKey.values()];
}

export interface TimelinePart {
  sessionId: string;
  stationId: string;
  stationOcppId: string;
  evseNumber: number | null;
  unitName: string | null;
  from: string;
  to: string | null;
  tariffName: string | null;
  maxCurrentA: number | null;
}

/** Splits each session at its tariff segments; a session without segments is one part. */
export function buildSessionTimeline(
  sessions: readonly {
    id: string;
    stationId: string;
    stationOcppId: string;
    evseNumber: number | null;
    unitName: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    tariffName: string | null;
    maxCurrentA: number | null;
  }[],
  segments: readonly {
    sessionId: string;
    startedAt: Date;
    endedAt: Date | null;
    tariffName: string | null;
    maxCurrentA: number | null;
  }[],
  showTariff: boolean,
): TimelinePart[] {
  const bySession = new Map<string, typeof segments>();
  for (const segment of segments) {
    bySession.set(segment.sessionId, [...(bySession.get(segment.sessionId) ?? []), segment]);
  }
  const parts: TimelinePart[] = [];
  for (const session of sessions) {
    if (session.startedAt == null) continue;
    const base = {
      sessionId: session.id,
      stationId: session.stationId,
      stationOcppId: session.stationOcppId,
      evseNumber: session.evseNumber,
      unitName: session.unitName,
    };
    const own = [...(bySession.get(session.id) ?? [])].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
    if (own.length === 0) {
      parts.push({
        ...base,
        from: session.startedAt.toISOString(),
        to: session.endedAt?.toISOString() ?? null,
        tariffName: showTariff ? session.tariffName : null,
        maxCurrentA: session.maxCurrentA,
      });
      continue;
    }
    for (const segment of own) {
      parts.push({
        ...base,
        from: segment.startedAt.toISOString(),
        to: (segment.endedAt ?? session.endedAt)?.toISOString() ?? null,
        tariffName: showTariff ? segment.tariffName : null,
        maxCurrentA: segment.maxCurrentA,
      });
    }
  }
  return parts;
}

function numberOrZero(value: string | null): number {
  const n = value == null ? 0 : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function loadAllocationLogRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:id/load-management/allocations',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List the load allocation log of a site',
        description: `Every limit load management sent at this site in the range, newest first, keyset paged. The range is at most ${String(LOAD_ALLOCATION_MAX_RANGE_DAYS)} days (else 400 LOAD_ALLOCATION_RANGE_TOO_LONG). Rows are the site's at send time, so a station that moved shows none from another site. sessionId needs sessions:read, tariffId and tariffName pricing:read (null otherwise).`,
        operationId: 'listSiteLoadAllocations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(listQuery),
        response: { 200: itemResponse(listResponse), 400: RANGE_ERRORS, 404: SITE_NOT_FOUND },
      },
    },
    async (request, reply) => {
      const siteId = await siteOfRequest(request, reply);
      if (siteId == null) return;
      const query = request.query as z.infer<typeof listQuery>;
      const range = await readRange(query, reply);
      if (range == null) return;
      const cursor = query.cursor != null ? decodeCursor(query.cursor) : undefined;
      if (cursor === null) {
        await reply
          .status(400)
          .send({ error: 'Invalid cursor', code: 'VALIDATION_ERROR', field: 'cursor' });
        return;
      }
      const conditions: (SQL | undefined)[] = [rangeWhere(siteId, range)];
      if (query.stationId != null) {
        conditions.push(eq(loadAllocationEntries.stationId, query.stationId));
      }
      if (query.evseNumber != null) {
        conditions.push(eq(loadAllocationEntries.evseNumber, query.evseNumber));
      }
      if (cursor != null) {
        conditions.push(
          or(
            lt(loadAllocationEntries.createdAt, cursor.createdAt),
            and(
              eq(loadAllocationEntries.createdAt, cursor.createdAt),
              lt(loadAllocationEntries.id, cursor.id),
            ),
          ),
        );
      }
      const [masks, rows] = await Promise.all([
        readMasks(request),
        selectEntries(and(...conditions), 'desc', query.limit + 1),
      ]);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const now = Date.now();
      return {
        data: page.map((row) => entryView(row, masks, now)),
        nextCursor:
          rows.length > query.limit && last != null ? encodeCursor(last.createdAt, last.id) : null,
      };
    },
  );

  app.get(
    '/sites/:id/load-management/allocations/export',
    {
      onRequest: [authorize('loadManagement:read')],
      config: {
        rateLimit: {
          max: 6,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return user?.userId ?? request.ip;
          },
        },
      },
      schema: {
        tags: ['Load Management'],
        summary: 'Export the load allocation log of a site as CSV',
        description: `The allocation log of the range (at most ${String(LOAD_ALLOCATION_MAX_RANGE_DAYS)} days, else 400 LOAD_ALLOCATION_RANGE_TOO_LONG), oldest first. Columns: ${LOAD_ALLOCATION_EXPORT_COLUMNS.join(', ')}. session needs sessions:read and tariff pricing:read (empty otherwise). Every text cell is formula safe. 6 exports a minute per user.`,
        operationId: 'exportSiteLoadAllocations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(rangeQuery),
        response: { 400: RANGE_ERRORS, 404: SITE_NOT_FOUND },
      },
    },
    async (request, reply) => {
      const siteId = await siteOfRequest(request, reply);
      if (siteId == null) return;
      const range = await readRange(request.query as z.infer<typeof rangeQuery>, reply);
      if (range == null) return;
      const masks = await readMasks(request);
      const now = Date.now();
      const lines: unknown[][] = [];
      let after: { createdAt: Date; id: number } | null = null;
      for (;;) {
        const where: SQL | undefined = and(
          rangeWhere(siteId, range),
          after == null
            ? undefined
            : or(
                gt(loadAllocationEntries.createdAt, after.createdAt),
                and(
                  eq(loadAllocationEntries.createdAt, after.createdAt),
                  gt(loadAllocationEntries.id, after.id),
                ),
              ),
        );
        const rows = await selectEntries(where, 'asc', EXPORT_PAGE_ROWS);
        for (const row of rows) lines.push(csvRow(entryView(row, masks, now)));
        const last = rows.at(-1);
        if (rows.length < EXPORT_PAGE_ROWS || last == null) break;
        after = { createdAt: last.createdAt, id: last.id };
      }
      const name = `load-allocations-${siteId}-${fileDate(range.from)}-${fileDate(range.to)}.csv`;
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .send(buildCsv(LOAD_ALLOCATION_EXPORT_COLUMNS, lines));
    },
  );

  app.get(
    '/sites/:id/load-management/allocations/series',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get the allocation chart series of a site',
        description: `Step series of the limits sent in the range (at most ${String(LOAD_ALLOCATION_MAX_RANGE_DAYS)} days), read from the allocation log only, so the chart and the CSV export agree: one per station limit and one per EVSE limited on its own, plus the site limit of the newest allocation and the current panel and transformer capacities as reference lines. At most ${String(ALLOCATION_SERIES_MAX_POINTS)} points (truncated true past that).`,
        operationId: 'getSiteLoadAllocationSeries',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(rangeQuery),
        response: { 200: itemResponse(seriesResponse), 400: RANGE_ERRORS, 404: SITE_NOT_FOUND },
      },
    },
    async (request, reply) => {
      const siteId = await siteOfRequest(request, reply);
      if (siteId == null) return;
      const range = await readRange(request.query as z.infer<typeof rangeQuery>, reply);
      if (range == null) return;
      const [rows, header, panelRows, transformerRows] = await Promise.all([
        selectEntries(rangeWhere(siteId, range), 'asc', ALLOCATION_SERIES_MAX_POINTS + 1),
        db
          .select({ siteLimitKw: loadAllocationLog.siteLimitKw })
          .from(loadAllocationLog)
          .where(
            and(
              eq(loadAllocationLog.siteId, siteId),
              gte(loadAllocationLog.createdAt, range.from),
              lt(loadAllocationLog.createdAt, range.to),
            ),
          )
          .orderBy(desc(loadAllocationLog.createdAt), desc(loadAllocationLog.id))
          .limit(1),
        db
          .select({ id: panels.id, name: panels.name, kw: panels.maxContinuousKw })
          .from(panels)
          .where(eq(panels.siteId, siteId))
          .orderBy(asc(panels.name)),
        db
          .select({
            id: transformers.id,
            name: transformers.name,
            kw: transformers.maxContinuousKw,
          })
          .from(transformers)
          .where(eq(transformers.siteId, siteId))
          .orderBy(asc(transformers.name)),
      ]);
      return {
        series: buildAllocationSeries(rows.slice(0, ALLOCATION_SERIES_MAX_POINTS)),
        references: {
          siteLimitKw: header[0] != null ? Number(header[0].siteLimitKw) : null,
          panels: panelRows.map((p) => ({ id: p.id, name: p.name, kw: numberOrZero(p.kw) })),
          transformers: transformerRows
            .filter((t) => t.kw != null)
            .map((t) => ({ id: t.id, name: t.name, kw: numberOrZero(t.kw) })),
        },
        truncated: rows.length > ALLOCATION_SERIES_MAX_POINTS,
      };
    },
  );

  app.get(
    '/sites/:id/load-management/allocations/sessions',
    {
      onRequest: [authorize('loadManagement:read', 'sessions:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get the session and tariff timeline of the allocation chart',
        description: `The sessions of this site (their own site) that overlap the range (at most ${String(LOAD_ALLOCATION_MAX_RANGE_DAYS)} days), split at their tariff segments. Needs sessions:read; tariffName needs pricing:read (null otherwise).`,
        operationId: 'getSiteLoadAllocationSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(rangeQuery),
        response: { 200: itemResponse(timelineResponse), 400: RANGE_ERRORS, 404: SITE_NOT_FOUND },
      },
    },
    async (request, reply) => {
      const siteId = await siteOfRequest(request, reply);
      if (siteId == null) return;
      const range = await readRange(request.query as z.infer<typeof rangeQuery>, reply);
      if (range == null) return;
      const [masks, sessions] = await Promise.all([
        readMasks(request),
        db
          .select({
            id: chargingSessions.id,
            stationId: chargingSessions.stationId,
            stationOcppId: chargingStations.stationId,
            evseNumber: evses.evseId,
            unitName: stationUnits.name,
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            tariffName: tariffs.name,
            maxCurrentA: chargingSessions.tariffMaxCurrentA,
          })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
          .leftJoin(evses, eq(evses.id, chargingSessions.evseId))
          .leftJoin(stationUnits, eq(stationUnits.id, evses.unitId))
          .leftJoin(tariffs, eq(tariffs.id, chargingSessions.tariffId))
          .where(
            and(
              eq(chargingSessions.siteId, siteId),
              isOperatorStation(),
              lt(chargingSessions.startedAt, range.to),
              or(isNull(chargingSessions.endedAt), gte(chargingSessions.endedAt, range.from)),
            ),
          )
          .orderBy(asc(chargingSessions.startedAt), asc(chargingSessions.id))
          .limit(5000),
      ]);
      const ids = sessions.map((s) => s.id);
      const segments =
        ids.length === 0
          ? []
          : await db
              .select({
                sessionId: sessionTariffSegments.sessionId,
                startedAt: sessionTariffSegments.startedAt,
                endedAt: sessionTariffSegments.endedAt,
                tariffName: tariffs.name,
                maxCurrentA: sessionTariffSegments.maxCurrentA,
              })
              .from(sessionTariffSegments)
              .leftJoin(tariffs, eq(tariffs.id, sessionTariffSegments.tariffId))
              .where(inArray(sessionTariffSegments.sessionId, ids));
      return {
        parts: buildSessionTimeline(sessions, segments, masks.pricing),
      };
    },
  );
}
