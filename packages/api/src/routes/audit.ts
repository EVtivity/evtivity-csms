// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  AUDIT_TABLES,
  users,
  drivers,
  refreshTokens,
  supportCases,
  toIsoOrNull,
} from '@evtivity/database';
import type { AuditEntityType } from '@evtivity/database';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorWith, paginatedResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { supportCaseSiteCondition } from '../lib/support-case-scope.js';
import {
  redactSupportCaseAuditRows,
  supportCaseAuditSessionCondition,
} from '../lib/support-case-redaction.js';
import type { JwtPayload } from '../plugins/auth.js';

const auditEntityTypes = Object.keys(AUDIT_TABLES) as AuditEntityType[];

const auditEntityTypeEnum = z.enum(auditEntityTypes as unknown as [string, ...string[]]);

const auditQuerystring = paginationQuery.extend({
  entityType: auditEntityTypeEnum.optional().describe('Filter by entity type'),
  entityId: z.string().optional().describe('Filter by entity id (or snapshot id)'),
  action: z.string().optional().describe('Filter by action verb'),
  actor: z
    .enum(['operator', 'driver', 'api_key', 'system', 'ocpp'])
    .optional()
    .describe('Filter by actor type'),
  actorUserId: z.string().optional().describe('Filter by acting operator user id'),
  actorDriverId: z.string().optional().describe('Filter by acting driver id'),
  from: z.string().datetime().optional().describe('ISO datetime, inclusive lower bound'),
  to: z.string().datetime().optional().describe('ISO datetime, inclusive upper bound'),
});

const auditItem = z
  .object({
    id: z.number().describe('Audit row id (per-table serial)'),
    entityType: z.string().describe('Audit table key (site, station, driver, ...)'),
    entityId: z.string().nullable().describe('Live entity id; null when row was deleted'),
    entityIdSnapshot: z.string().describe('Entity id at audit time, preserved across deletes'),
    action: z.string().describe('Per-entity action verb'),
    actor: z.string().describe('Actor type'),
    actorUserId: z.string().nullable(),
    actorDriverId: z.string().nullable(),
    actorApiKeyId: z.string().nullable(),
    actorLabel: z.string().nullable().describe('Free-text label for system / ocpp actors'),
    actorName: z
      .string()
      .nullable()
      .describe('Resolved display name for the operator / driver / api key actor'),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    notes: z.string().nullable(),
    viaAi: z
      .object({
        conversationId: z.string().describe('AI conversation the change came from'),
        toolCallId: z.string().describe('Tool call (ai_tool_calls id) that made the change'),
      })
      .passthrough()
      .nullable()
      .describe('Set when an AI assistant tool call made the change, after the user confirmed it'),
    createdAt: z.string().describe('ISO datetime'),
  })
  .passthrough();

interface NormalizedAuditRow {
  id: number;
  entityType: string;
  entityId: string | null;
  entityIdSnapshot: string;
  action: string;
  actor: string;
  actorUserId: string | null;
  actorDriverId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
  /** Resolved display name for the actor (operator name, driver name, api
   * key name). Null when the actor is system / ocpp or the referenced row
   * was deleted. */
  actorName: string | null;
  before: unknown;
  after: unknown;
  notes: string | null;
  viaAi: unknown;
  createdAt: string;
}

// Looks up display names for every operator user, driver, and api key
// referenced in the row set, in three batched queries. Returns a row -> name
// resolver that can be used to enrich the rows for the response.
async function resolveActorNames(
  rows: Array<{
    actorUserId: string | null;
    actorDriverId: string | null;
    actorApiKeyId: string | null;
  }>,
): Promise<{
  byUserId: Map<string, string>;
  byDriverId: Map<string, string>;
  byApiKeyId: Map<string, string>;
}> {
  const userIds = new Set<string>();
  const driverIds = new Set<string>();
  const apiKeyIds = new Set<string>();
  for (const r of rows) {
    if (r.actorUserId != null) userIds.add(r.actorUserId);
    if (r.actorDriverId != null) driverIds.add(r.actorDriverId);
    if (r.actorApiKeyId != null) apiKeyIds.add(r.actorApiKeyId);
  }
  const [userRows, driverRows, apiKeyRows] = await Promise.all([
    userIds.size > 0
      ? db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : Promise.resolve([]),
    driverIds.size > 0
      ? db
          .select({
            id: drivers.id,
            firstName: drivers.firstName,
            lastName: drivers.lastName,
            email: drivers.email,
          })
          .from(drivers)
          .where(inArray(drivers.id, [...driverIds]))
      : Promise.resolve([]),
    apiKeyIds.size > 0
      ? db
          .select({ id: refreshTokens.id, name: refreshTokens.name })
          .from(refreshTokens)
          .where(
            inArray(
              refreshTokens.id,
              [...apiKeyIds].map((s) => Number(s)).filter((n) => Number.isFinite(n)),
            ),
          )
      : Promise.resolve([]),
  ]);

  const byUserId = new Map<string, string>();
  for (const u of userRows as Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  }>) {
    const name = [u.firstName ?? '', u.lastName ?? ''].join(' ').trim();
    byUserId.set(u.id, name || u.email);
  }
  const byDriverId = new Map<string, string>();
  for (const d of driverRows as Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  }>) {
    const name = [d.firstName ?? '', d.lastName ?? ''].join(' ').trim();
    byDriverId.set(d.id, name || d.email);
  }
  const byApiKeyId = new Map<string, string>();
  for (const k of apiKeyRows as Array<{ id: number; name: string | null }>) {
    if (k.name != null) byApiKeyId.set(String(k.id), k.name);
  }
  return { byUserId, byDriverId, byApiKeyId };
}

function actorNameFor(
  row: { actorUserId: string | null; actorDriverId: string | null; actorApiKeyId: string | null },
  resolver: {
    byUserId: Map<string, string>;
    byDriverId: Map<string, string>;
    byApiKeyId: Map<string, string>;
  },
): string | null {
  if (row.actorUserId != null) return resolver.byUserId.get(row.actorUserId) ?? null;
  if (row.actorDriverId != null) return resolver.byDriverId.get(row.actorDriverId) ?? null;
  if (row.actorApiKeyId != null) return resolver.byApiKeyId.get(row.actorApiKeyId) ?? null;
  return null;
}

// id-column name varies per table. Most tables follow `<entity>_id`, with
// these exceptions:
//   - setting: keyed by `setting_key` (no surrogate id on the settings table)
//   - local_auth_list: changes are tracked at the station level (`station_id`),
//     not per-entry, because pushes/pulls/adds/removes are station-scoped
//   - station_image: full column name not abbreviated (`station_image_id`)
function idColumnFor(entityType: AuditEntityType): string {
  if (entityType === 'setting') return 'setting_key';
  if (entityType === 'local_auth_list') return 'station_id';
  if (entityType === 'station_image') return 'station_image_id';
  // Audit-table columns for these entities use shorter names than the entity
  // type itself would imply. The schema picked these because the full names
  // (e.g. smart_charging_template_id_snapshot) collided with Postgres'
  // 63-char identifier limit on the corresponding index name.
  if (entityType === 'smart_charging_template') return 'template_id';
  if (entityType === 'config_template') return 'template_id';
  if (entityType === 'firmware_campaign') return 'campaign_id';
  return `${entityType}_id`;
}

// The site an audit row's entity belongs to, as a scalar SQL subquery over the
// row's live id column. Entity types with no site (company-wide settings,
// drivers, pricing, users, ...) return null: their history is visible to
// all-site users only. Deleted entities have a null live id and so no site.
// Support cases are scoped by auditSiteCondition instead, so their history
// follows the case's own visibility.
function entitySiteSql(entityType: AuditEntityType, idCol: string): SQL | null {
  const id = auditIdSql(entityType, idCol);
  switch (entityType) {
    case 'site':
      return sql`${id}`;
    case 'station':
    case 'local_auth_list':
      return sql`(SELECT cs.site_id FROM charging_stations cs WHERE cs.id = ${id})`;
    case 'station_image':
      return sql`(SELECT cs.site_id FROM station_images si JOIN charging_stations cs ON cs.id = si.station_id WHERE si.id::text = ${id})`;
    case 'reservation':
      return sql`(SELECT cs.site_id FROM reservations r JOIN charging_stations cs ON cs.id = r.station_id WHERE r.id = ${id})`;
    case 'session':
      return sql`(SELECT cs.site_id FROM charging_sessions s JOIN charging_stations cs ON cs.id = s.station_id WHERE s.id = ${id})`;
    case 'maintenance_event':
      return sql`(SELECT m.site_id FROM maintenance_events m WHERE m.id = ${id})`;
    default:
      return null;
  }
}

// The audit row's live entity id, qualified with the audit table: the joined
// tables have columns of the same name (charging_stations.station_id is the
// OCPP identity).
function auditIdSql(entityType: AuditEntityType, idCol: string): SQL {
  return sql`${sql.identifier(`${entityType}_audit_log`)}.${sql.identifier(idCol)}`;
}

/**
 * Site scope condition for one audit table. Returns undefined for an all-site
 * user (no filter), null when the table is invisible to the user (no site can
 * be derived, or the user has no sites), else the WHERE fragment.
 */
function auditSiteCondition(
  entityType: AuditEntityType,
  idCol: string,
  siteIds: string[] | null,
): SQL | null | undefined {
  if (siteIds == null) return undefined;
  if (siteIds.length === 0) return null;
  // A support case's history is visible exactly when the case is, without
  // the rows about sessions of other sites (redactSupportCaseAuditRows trims
  // the rest).
  if (entityType === 'support_case') {
    return sql`EXISTS (SELECT 1 FROM ${supportCases} WHERE ${supportCases.id} = ${auditIdSql(
      entityType,
      idCol,
    )} AND ${supportCaseSiteCondition(siteIds)}) AND ${supportCaseAuditSessionCondition(siteIds)}`;
  }
  const siteExpr = entitySiteSql(entityType, idCol);
  if (siteExpr == null) return null;
  return sql`${siteExpr} IN (${sql.join(
    siteIds.map((siteId) => sql`${siteId}`),
    sql`, `,
  )})`;
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function normalizeRow(entityType: string, raw: Record<string, unknown>): NormalizedAuditRow {
  const idCol = idColumnFor(entityType as AuditEntityType);
  const snapshotCol = `${idCol}_snapshot`;
  const createdAt = raw['created_at'];
  return {
    id: Number(raw['id']),
    entityType,
    entityId: (raw[idCol] as string | null) ?? null,
    entityIdSnapshot: asString(raw[snapshotCol]),
    action: asString(raw['action']),
    actor: asString(raw['actor']),
    actorUserId: (raw['actor_user_id'] as string | null) ?? null,
    actorDriverId: (raw['actor_driver_id'] as string | null) ?? null,
    actorApiKeyId: (raw['actor_api_key_id'] as string | null) ?? null,
    actorLabel: (raw['actor_label'] as string | null) ?? null,
    actorName: null,
    before: raw['before'] ?? null,
    after: raw['after'] ?? null,
    notes: (raw['notes'] as string | null) ?? null,
    viaAi: raw['via_ai'] ?? null,
    // The shared client returns created_at as postgres text: map it to ISO.
    createdAt: toIsoOrNull(createdAt as Date | string | null) ?? new Date().toISOString(),
  };
}

export function auditRoutes(app: FastifyInstance): void {
  // Both endpoints are gated by `audit:read`. Using a single permission keeps
  // API key scoping intact: the rbac middleware intersects the user's
  // permissions with the api key's `apiKeyPermissions` array. A custom
  // in-handler permission check would bypass that intersection.
  // The trade-off is that audit:read grants access to every entity's audit
  // history, not just the entities the operator has :read on. Operators who
  // should only see (e.g.) station audit but not settings audit should not
  // be granted audit:read at all.
  app.get(
    '/audit/:entityType/:entityId',
    {
      onRequest: [authorize('audit:read')],
      schema: {
        tags: ['Audit'],
        summary: 'List audit entries for one entity',
        operationId: 'listEntityAudit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(
          z.object({
            entityType: auditEntityTypeEnum.describe('Entity type'),
            entityId: z.string().describe('Entity id (live id or snapshot for deleted rows)'),
          }),
        ),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(auditItem),
          400: errorWith('Unknown audit entity type', [ERROR_CODES.AUDIT_ENTITY_TYPE_INVALID]),
        },
      },
    },
    async (request, reply) => {
      const { entityType, entityId } = request.params as {
        entityType: string;
        entityId: string;
      };
      if (!Object.prototype.hasOwnProperty.call(AUDIT_TABLES, entityType)) {
        await reply
          .status(400)
          .send({ error: 'Unknown entity type', code: 'AUDIT_ENTITY_TYPE_INVALID' });
        return;
      }
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const idCol = idColumnFor(entityType as AuditEntityType);
      const snapshotCol = `${idCol}_snapshot`;
      const tableName = `${entityType}_audit_log`;
      // A site-restricted user sees the history of entities in its sites only
      // (an empty page otherwise, so the entity's existence does not leak).
      const { userId } = request.user as JwtPayload;
      const entitySiteIds = await getUserSiteIds(userId);
      const siteCond = auditSiteCondition(entityType as AuditEntityType, idCol, entitySiteIds);
      if (siteCond === null) return { data: [], total: 0 } satisfies PaginatedResponse<unknown>;
      const scope = siteCond != null ? sql` AND ${siteCond}` : sql``;
      const [rowsRes, countRes] = await Promise.all([
        db.execute(sql`
          SELECT * FROM ${sql.identifier(tableName)}
          WHERE (${sql.identifier(idCol)} = ${entityId}
             OR ${sql.identifier(snapshotCol)} = ${entityId})${scope}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
        db.execute(sql`
          SELECT COUNT(*)::int AS total FROM ${sql.identifier(tableName)}
          WHERE (${sql.identifier(idCol)} = ${entityId}
             OR ${sql.identifier(snapshotCol)} = ${entityId})${scope}
        `),
      ]);
      const rows = await redactSupportCaseAuditRows(
        (rowsRes as unknown as Array<Record<string, unknown>>).map((r) =>
          normalizeRow(entityType, r),
        ),
        entitySiteIds,
      );
      const total = (countRes as unknown as Array<{ total: number }>)[0]?.total ?? 0;

      const resolver = await resolveActorNames(rows);
      for (const row of rows) row.actorName = actorNameFor(row, resolver);
      return { data: rows, total } satisfies PaginatedResponse<unknown>;
    },
  );

  // Global cross-entity audit endpoint. UNION ALL across selected entity
  // tables, filtered server-side, sorted newest-first. Falls back to
  // querying each table when filters apply -- still cheap because each
  // table has indexes on (entity_id, created_at).
  app.get(
    '/audit',
    {
      onRequest: [authorize('audit:read')],
      schema: {
        tags: ['Audit'],
        summary: 'List audit entries across all entities',
        operationId: 'listAudit',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(auditQuerystring),
        response: { 200: paginatedResponse(auditItem) },
      },
    },
    async (request) => {
      const q = request.query as z.infer<typeof auditQuerystring>;
      const offset = (q.page - 1) * q.limit;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      // A site-restricted user gets only the tables whose entities belong to
      // a site, each filtered to the user's sites.
      const types: AuditEntityType[] = (
        q.entityType != null ? [q.entityType as AuditEntityType] : auditEntityTypes
      ).filter((t) => auditSiteCondition(t, idColumnFor(t), siteIds) !== null);
      if (types.length === 0) return { data: [], total: 0 } satisfies PaginatedResponse<unknown>;

      // Build per-table SELECT branches with shared filters. We project a
      // common shape: id, entity_type literal, idCol AS entity_id, snapshot
      // AS entity_id_snapshot, action::text, actor::text, actor_*, before,
      // after, notes, created_at.
      // Build the branch list twice -- once for the data query (with full
      // SELECT projection) and once for the count query (SELECT 1) -- so
      // each call to db.execute holds independent sql template state.
      function buildBranches(projection: 'data' | 'count'): ReturnType<typeof sql>[] {
        return types.map((t) => {
          const tableName = `${t}_audit_log`;
          const idCol = idColumnFor(t);
          const snapshotCol = `${idCol}_snapshot`;
          const conds: ReturnType<typeof sql>[] = [];
          const siteCond = auditSiteCondition(t, idCol, siteIds);
          if (siteCond != null) conds.push(siteCond);
          if (q.action != null) conds.push(sql`action::text = ${q.action}`);
          if (q.actor != null) conds.push(sql`actor::text = ${q.actor}`);
          if (q.actorUserId != null) conds.push(sql`actor_user_id = ${q.actorUserId}`);
          if (q.actorDriverId != null) conds.push(sql`actor_driver_id = ${q.actorDriverId}`);
          if (q.from != null) conds.push(sql`created_at >= ${q.from}::timestamptz`);
          if (q.to != null) conds.push(sql`created_at <= ${q.to}::timestamptz`);
          if (q.entityId != null) {
            conds.push(
              sql`(${sql.identifier(idCol)} = ${q.entityId} OR ${sql.identifier(snapshotCol)} = ${q.entityId})`,
            );
          }
          const whereClause = conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
          if (projection === 'count') {
            return sql`SELECT 1 AS one FROM ${sql.identifier(tableName)} ${whereClause}`;
          }
          return sql`
            SELECT id,
                   ${t}::text AS entity_type,
                   ${sql.identifier(idCol)} AS entity_id,
                   ${sql.identifier(snapshotCol)} AS entity_id_snapshot,
                   action::text AS action,
                   actor::text AS actor,
                   actor_user_id,
                   actor_driver_id,
                   actor_api_key_id,
                   actor_label,
                   before,
                   after,
                   notes,
                   via_ai,
                   created_at
            FROM ${sql.identifier(tableName)}
            ${whereClause}
          `;
        });
      }

      const dataSql = sql`
        ${sql.join(buildBranches('data'), sql` UNION ALL `)}
        ORDER BY created_at DESC, entity_type ASC, id DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;
      const countSql = sql`SELECT COUNT(*)::int AS total FROM (${sql.join(buildBranches('count'), sql` UNION ALL `)}) sub`;

      const [rowsRes, countRes] = await Promise.all([db.execute(dataSql), db.execute(countSql)]);
      const mapped = (rowsRes as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: Number(r['id']),
        entityType: asString(r['entity_type']),
        entityId: (r['entity_id'] as string | null) ?? null,
        entityIdSnapshot: asString(r['entity_id_snapshot']),
        action: asString(r['action']),
        actor: asString(r['actor']),
        actorUserId: (r['actor_user_id'] as string | null) ?? null,
        actorDriverId: (r['actor_driver_id'] as string | null) ?? null,
        actorApiKeyId: (r['actor_api_key_id'] as string | null) ?? null,
        actorLabel: (r['actor_label'] as string | null) ?? null,
        actorName: null as string | null,
        before: r['before'] ?? null,
        after: r['after'] ?? null,
        notes: (r['notes'] as string | null) ?? null,
        viaAi: r['via_ai'] ?? null,
        createdAt: toIsoOrNull(r['created_at'] as Date | string | null) ?? '',
      }));
      const out = await redactSupportCaseAuditRows(mapped, siteIds);
      const resolver = await resolveActorNames(out);
      for (const row of out) row.actorName = actorNameFor(row, resolver);
      const total = (countRes as unknown as Array<{ total: number }>)[0]?.total ?? 0;
      return { data: out, total } satisfies PaginatedResponse<unknown>;
    },
  );
}
