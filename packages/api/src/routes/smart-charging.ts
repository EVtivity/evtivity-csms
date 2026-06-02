// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray, ne, max } from 'drizzle-orm';
import {
  db,
  chargingProfileTemplates,
  chargingProfilePushes,
  chargingProfilePushStations,
  chargingStations,
  sites,
  vendors,
  writeAudit,
  smartChargingTemplateAuditLog,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import {
  processChargingProfilePush,
  processChargingProfileClear,
} from '../lib/charging-profile-push.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

// OCPP 2.1 ChargingProfilePurposeEnumType minus the two purposes excluded from
// templates: TxProfile (needs a transactionId per station) and
// ChargingStationExternalConstraints (reserved for the load-management loop;
// template pushes would race with the 10s allocator).
const TEMPLATE_PROFILE_PURPOSES = [
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'PriorityCharging',
  'LocalGeneration',
] as const;

const templateItem = z
  .object({
    id: z.string().describe('Template ID'),
    name: z.string().describe('Template name'),
    description: z.string().nullable().describe('Template description'),
    ocppVersion: z.enum(['2.1', '1.6']).describe('OCPP version'),
    profileId: z.number().describe('OCPP charging profile ID'),
    profilePurpose: z.enum(TEMPLATE_PROFILE_PURPOSES).describe('Charging profile purpose'),
    profileKind: z.enum(['Absolute', 'Recurring']).describe('Charging profile kind'),
    recurrencyKind: z.enum(['Daily', 'Weekly']).nullable().describe('Recurrency kind'),
    stackLevel: z.number().describe('Stack level'),
    evseId: z.number().describe('EVSE ID (0 for station-wide)'),
    chargingRateUnit: z.enum(['W', 'A']).describe('Charging rate unit'),
    schedulePeriods: z.unknown().describe('Charging schedule periods (JSONB array)'),
    startSchedule: z.string().nullable().describe('Schedule start time (ISO 8601)'),
    duration: z.number().nullable().describe('Schedule duration in seconds'),
    validFrom: z.string().nullable().describe('Profile validity start (ISO 8601)'),
    validTo: z.string().nullable().describe('Profile validity end (ISO 8601)'),
    targetFilter: z
      .record(z.unknown())
      .nullable()
      .describe('Filter to select target stations (siteId/vendorId/model)'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
    matchingStationsCount: z
      .number()
      .optional()
      .describe('Number of stations matching the target filter (only on list endpoint)'),
  })
  .passthrough();
const templateParams = z.object({ id: z.string().describe('Template ID') });

const filterOptionsItem = z
  .object({
    sites: z
      .array(
        z
          .object({
            id: z.string().describe('Site identifier'),
            name: z.string().describe('Site display name'),
          })
          .passthrough(),
      )
      .describe('Sites the user can access'),
    vendors: z
      .array(
        z
          .object({
            id: z.string().describe('Vendor identifier'),
            name: z.string().describe('Vendor display name'),
          })
          .passthrough(),
      )
      .describe('All vendors'),
    models: z.array(z.string()).describe('Distinct station model names'),
  })
  .passthrough();

const matchingStationItem = z
  .object({
    id: z.string().describe('Station UUID'),
    stationId: z.string().describe('OCPP station identifier'),
    model: z.string().nullable().describe('Station model'),
    siteName: z.string().nullable().describe('Site name'),
    vendorName: z.string().nullable().describe('Vendor name'),
  })
  .passthrough();

const pushItem = z
  .object({
    id: z.string().describe('Push ID'),
    templateId: z.string().describe('Template ID'),
    operation: z.string().describe('Push operation (set or clear)'),
    status: z.string().describe('Push status (active or completed)'),
    stationCount: z.number().describe('Number of stations targeted'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
    pendingCount: z.number().describe('Stations with pending status'),
    acceptedCount: z.number().describe('Stations that accepted the profile'),
    rejectedCount: z.number().describe('Stations that rejected the profile'),
    failedCount: z.number().describe('Stations where dispatch failed'),
  })
  .passthrough();

const pushDetailItem = z
  .object({
    id: z.string().describe('Push ID'),
    templateId: z.string().describe('Template ID'),
    operation: z.string().describe('Push operation (set or clear)'),
    status: z.string().describe('Push status (active or completed)'),
    stationCount: z.number().describe('Number of stations targeted'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
    pendingCount: z.number().describe('Stations with pending status'),
    acceptedCount: z.number().describe('Stations that accepted the profile'),
    rejectedCount: z.number().describe('Stations that rejected the profile'),
    failedCount: z.number().describe('Stations where dispatch failed'),
    stations: z
      .array(
        z
          .object({
            id: z.number().describe('Push-station row ID'),
            stationId: z.string().describe('Station UUID'),
            stationName: z.string().describe('OCPP station identifier'),
            status: z.string().describe('Per-station push status'),
            errorInfo: z.string().nullable().describe('Error info when failed/rejected'),
            updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
          })
          .passthrough(),
      )
      .describe('Per-station push results (paginated)'),
    stationsTotal: z.number().describe('Total number of stations in this push'),
  })
  .passthrough();

// Postgres unique-violation (23505) on the profile_id constraint. Used as a
// race-safe backstop for the JS-side pre-check on concurrent inserts.
function isProfileIdUniqueViolation(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint_name?: string; constraint?: string };
  if (e.code !== '23505') return false;
  const constraint = e.constraint_name ?? e.constraint ?? '';
  return constraint === 'charging_profile_templates_profile_id_unique';
}

const targetFilterSchema = z
  .object({
    siteId: z.string().optional(),
    vendorId: z.string().optional(),
    model: z.string().optional(),
  })
  .optional()
  .nullable();

// Resolve the set of stations a template's push/clear should reach. Combines
// the template's targetFilter (siteId/vendorId/model) with the user's site
// access and the version + online predicates. Pulled out because push and
// clear handlers both build the identical predicate; the matching-stations
// preview adds its own pagination so it inlines the pieces it needs.
async function resolveTemplateTargetStations(
  template: { ocppVersion: string; targetFilter: unknown },
  userId: string,
): Promise<Array<{ id: string; stationId: string }>> {
  const expectedProtocol = `ocpp${template.ocppVersion}`;
  const filter = template.targetFilter as Record<string, string> | null;

  const accessibleSiteIds = await getUserSiteIds(userId);
  if (accessibleSiteIds != null && accessibleSiteIds.length === 0) return [];

  const conditions = [
    eq(chargingStations.isOnline, true),
    eq(chargingStations.ocppProtocol, expectedProtocol),
  ];
  if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
  if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
  if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));
  if (accessibleSiteIds != null) {
    conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));
  }

  return db
    .select({ id: chargingStations.id, stationId: chargingStations.stationId })
    .from(chargingStations)
    .where(and(...conditions));
}

const schedulePeriodSchema = z.object({
  startPeriod: z
    .number()
    .int()
    .min(0)
    .describe('Seconds from the start of the schedule. Must be a non-negative integer.'),
  limit: z
    .number()
    .describe(
      'Charging rate limit. Negative values are permitted only for V2G discharge profiles per OCPP 2.1.',
    ),
  numberPhases: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe('Number of phases (1-3). Optional.'),
});

const createTemplateBody = z
  .object({
    name: z.string().min(1).describe('Template name'),
    description: z.string().optional().describe('Template description'),
    ocppVersion: z.enum(['2.1', '1.6']).default('2.1').describe('OCPP version'),
    profileId: z.number().int().default(100).describe('OCPP charging profile ID'),
    profilePurpose: z.enum(TEMPLATE_PROFILE_PURPOSES).describe('Charging profile purpose'),
    profileKind: z.enum(['Absolute', 'Recurring']).describe('Charging profile kind'),
    recurrencyKind: z
      .enum(['Daily', 'Weekly'])
      .optional()
      .describe('Recurrency kind (required if Recurring)'),
    stackLevel: z.number().int().min(0).default(0).describe('Stack level'),
    evseId: z.number().int().min(0).default(0).describe('EVSE ID (0 for station-wide)'),
    chargingRateUnit: z.enum(['W', 'A']).default('W').describe('Charging rate unit'),
    schedulePeriods: z
      .array(schedulePeriodSchema)
      .min(1, 'At least one schedule period is required')
      .refine(
        (periods) => {
          // OCPP 2.1 chargingSchedulePeriod requires startPeriod values to be
          // strictly ascending so the station can resolve which period is
          // active at any wall-clock offset. Without this guard, overlapping
          // or out-of-order periods reach the station and either get rejected
          // or produce ambiguous behaviour.
          for (let i = 1; i < periods.length; i++) {
            const current = periods[i];
            const previous = periods[i - 1];
            if (current == null || previous == null) return false;
            if (current.startPeriod <= previous.startPeriod) return false;
          }
          return true;
        },
        { message: 'schedulePeriods must be ordered by strictly increasing startPeriod' },
      )
      .describe('Charging schedule periods (ordered by ascending startPeriod)'),
    startSchedule: z.string().datetime().optional().describe('Schedule start time (ISO 8601)'),
    duration: z.number().int().optional().describe('Schedule duration in seconds'),
    validFrom: z.string().datetime().optional().describe('Profile validity start (ISO 8601)'),
    validTo: z.string().datetime().optional().describe('Profile validity end (ISO 8601)'),
    targetFilter: targetFilterSchema.describe('Filter to select target stations'),
  })
  .refine(
    (data) => {
      // Reject obviously-broken validity windows on input so the station
      // never receives a profile that is "valid from 2026-12-01 until
      // 2025-01-01" - stations either reject it cryptically or honour it
      // never, with no operator-visible signal.
      if (data.validFrom != null && data.validTo != null) {
        return new Date(data.validFrom).getTime() < new Date(data.validTo).getTime();
      }
      return true;
    },
    { message: 'validFrom must be strictly before validTo' },
  )
  .refine(
    (data) => {
      // OCPP 2.1 ChargingProfile spec: Recurring profiles MUST carry a
      // startSchedule anchor so the station knows when each cycle begins.
      // Without this guard the station receives a Recurring profile with
      // no anchor and either rejects it or treats it as Absolute.
      if (data.profileKind === 'Recurring') {
        return data.startSchedule != null && data.startSchedule !== '';
      }
      return true;
    },
    {
      message: 'startSchedule is required when profileKind is Recurring',
      path: ['startSchedule'],
    },
  );

const updateTemplateBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    ocppVersion: z.enum(['2.1', '1.6']).optional(),
    profileId: z.number().int().optional(),
    profilePurpose: z.enum(TEMPLATE_PROFILE_PURPOSES).optional(),
    profileKind: z.enum(['Absolute', 'Recurring']).optional(),
    recurrencyKind: z.enum(['Daily', 'Weekly']).optional().nullable(),
    stackLevel: z.number().int().min(0).optional(),
    evseId: z.number().int().min(0).optional(),
    chargingRateUnit: z.enum(['W', 'A']).optional(),
    schedulePeriods: z.array(schedulePeriodSchema).min(1).optional(),
    startSchedule: z.string().datetime().optional().nullable(),
    duration: z.number().int().optional().nullable(),
    validFrom: z.string().datetime().optional().nullable(),
    validTo: z.string().datetime().optional().nullable(),
    targetFilter: targetFilterSchema,
  })
  .refine(
    (data) => {
      if (data.validFrom != null && data.validTo != null) {
        return new Date(data.validFrom).getTime() < new Date(data.validTo).getTime();
      }
      return true;
    },
    { message: 'validFrom must be strictly before validTo' },
  );

export function smartChargingRoutes(app: FastifyInstance): void {
  // Filter options for target filter dropdowns
  app.get(
    '/smart-charging/filter-options',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Get filter options for smart charging template targeting',
        operationId: 'getSmartChargingFilterOptions',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(filterOptionsItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);

      const siteQuery = db.select({ id: sites.id, name: sites.name }).from(sites);
      const [siteRows, vendorRows, modelRows] = await Promise.all([
        accessibleSiteIds != null
          ? siteQuery.where(inArray(sites.id, accessibleSiteIds)).orderBy(asc(sites.name))
          : siteQuery.orderBy(asc(sites.name)),
        db.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
        db
          .selectDistinct({ model: chargingStations.model })
          .from(chargingStations)
          .where(isNotNull(chargingStations.model))
          .orderBy(asc(chargingStations.model)),
      ]);

      return {
        sites: siteRows,
        vendors: vendorRows,
        models: modelRows.map((r) => r.model as string),
      };
    },
  );

  // List templates
  app.get(
    '/smart-charging/templates',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'List charging profile templates',
        operationId: 'listChargingProfileTemplates',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(templateItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [rows, countResult] = await Promise.all([
        db
          .select()
          .from(chargingProfileTemplates)
          .orderBy(desc(chargingProfileTemplates.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingProfileTemplates),
      ]);

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);

      const data = await Promise.all(
        rows.map(async (template) => {
          const filter = template.targetFilter as Record<string, string> | null;
          const conds = [eq(chargingStations.ocppProtocol, `ocpp${template.ocppVersion}`)];
          if (filter?.siteId) conds.push(eq(chargingStations.siteId, filter.siteId));
          if (filter?.vendorId) conds.push(eq(chargingStations.vendorId, filter.vendorId));
          if (filter?.model) conds.push(eq(chargingStations.model, filter.model));
          if (accessibleSiteIds != null) {
            if (accessibleSiteIds.length === 0) return { ...template, matchingStationsCount: 0 };
            conds.push(inArray(chargingStations.siteId, accessibleSiteIds));
          }
          const [r] = await db
            .select({ total: count() })
            .from(chargingStations)
            .where(and(...conds));
          return { ...template, matchingStationsCount: r?.total ?? 0 };
        }),
      );

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get template
  app.get(
    '/smart-charging/templates/:id',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Get charging profile template',
        operationId: 'getChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          200: itemResponse(templateItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      return template;
    },
  );

  // Create template
  app.post(
    '/smart-charging/templates',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Create a charging profile template',
        operationId: 'createChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTemplateBody),
        response: {
          201: itemResponse(templateItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          409: errorWith('Profile id in use', [ERROR_CODES.PROFILE_ID_IN_USE]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTemplateBody>;

      // profilePurpose is now constrained to TEMPLATE_PROFILE_PURPOSES at the
      // schema layer; the prior runtime guard against TxProfile and
      // ChargingStationExternalConstraints is unreachable.

      // Validate recurrencyKind requirement
      if (body.profileKind === 'Recurring' && !body.recurrencyKind) {
        await reply.status(400).send({
          error: 'recurrencyKind is required when profileKind is Recurring',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // OCPP profile id is the per-station unique identifier; reusing it across
      // templates would have the second push silently overwrite the first on
      // any shared station. The DB has a UNIQUE constraint on profile_id which
      // is the source of truth under concurrency; we still pre-check for a fast
      // 409 response and rely on the constraint to backstop races.
      const existingByProfileId = await db
        .select({ id: chargingProfileTemplates.id })
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.profileId, body.profileId))
        .limit(1);
      if (existingByProfileId[0] != null) {
        await reply.status(409).send({
          error: `profileId ${String(body.profileId)} is already used by another template`,
          code: 'PROFILE_ID_IN_USE',
        });
        return;
      }

      try {
        const [template] = await db
          .insert(chargingProfileTemplates)
          .values({
            name: body.name,
            description: body.description ?? null,
            ocppVersion: body.ocppVersion,
            profileId: body.profileId,
            profilePurpose: body.profilePurpose,
            profileKind: body.profileKind,
            recurrencyKind: body.recurrencyKind ?? null,
            stackLevel: body.stackLevel,
            evseId: body.evseId,
            chargingRateUnit: body.chargingRateUnit,
            schedulePeriods: body.schedulePeriods,
            startSchedule: body.startSchedule ? new Date(body.startSchedule) : null,
            duration: body.duration ?? null,
            validFrom: body.validFrom ? new Date(body.validFrom) : null,
            validTo: body.validTo ? new Date(body.validTo) : null,
            targetFilter: body.targetFilter ?? null,
          })
          .returning();

        if (template != null) {
          const actor = getAuditActor(request);
          await writeAudit(
            { table: smartChargingTemplateAuditLog, idColumn: 'template_id' },
            {
              entityId: template.id,
              entityIdSnapshot: template.id,
              action: 'created',
              ...actor,
              after: template,
            },
            db,
            request.log,
          );
        }

        return await reply.status(201).send(template);
      } catch (err) {
        if (isProfileIdUniqueViolation(err)) {
          await reply.status(409).send({
            error: `profileId ${String(body.profileId)} is already used by another template`,
            code: 'PROFILE_ID_IN_USE',
          });
          return;
        }
        throw err;
      }
    },
  );

  // Update template
  app.patch(
    '/smart-charging/templates/:id',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Update a charging profile template',
        operationId: 'updateChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        body: zodSchema(updateTemplateBody),
        response: {
          200: itemResponse(templateItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
          409: errorWith('Profile id in use', [ERROR_CODES.PROFILE_ID_IN_USE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const body = request.body as z.infer<typeof updateTemplateBody>;

      const [existing] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      // Validate recurrencyKind requirement on the resulting state
      const effectiveKind = body.profileKind ?? existing.profileKind;
      const effectiveRecurrency =
        body.recurrencyKind !== undefined ? body.recurrencyKind : existing.recurrencyKind;
      if (effectiveKind === 'Recurring' && !effectiveRecurrency) {
        await reply.status(400).send({
          error: 'recurrencyKind is required when profileKind is Recurring',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // Validate validFrom < validTo on the resulting state. The body-level
      // refine in updateTemplateBody only fires when BOTH are present in the
      // request; without this guard a PATCH that sends only `validFrom` (or
      // only `validTo`) can produce a row where validFrom > validTo by
      // combining the new value with the unchanged existing one.
      const effectiveValidFromRaw =
        body.validFrom !== undefined ? body.validFrom : existing.validFrom;
      const effectiveValidToRaw = body.validTo !== undefined ? body.validTo : existing.validTo;
      const effectiveValidFrom =
        effectiveValidFromRaw == null
          ? null
          : effectiveValidFromRaw instanceof Date
            ? effectiveValidFromRaw
            : new Date(effectiveValidFromRaw);
      const effectiveValidTo =
        effectiveValidToRaw == null
          ? null
          : effectiveValidToRaw instanceof Date
            ? effectiveValidToRaw
            : new Date(effectiveValidToRaw);
      if (
        effectiveValidFrom != null &&
        effectiveValidTo != null &&
        effectiveValidFrom.getTime() >= effectiveValidTo.getTime()
      ) {
        await reply.status(400).send({
          error: 'validFrom must be strictly before validTo',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // Reject profileId collisions with other templates.
      if (body.profileId !== undefined && body.profileId !== existing.profileId) {
        const collision = await db
          .select({ id: chargingProfileTemplates.id })
          .from(chargingProfileTemplates)
          .where(
            and(
              eq(chargingProfileTemplates.profileId, body.profileId),
              ne(chargingProfileTemplates.id, id),
            ),
          )
          .limit(1);
        if (collision[0] != null) {
          await reply.status(409).send({
            error: `profileId ${String(body.profileId)} is already used by another template`,
            code: 'PROFILE_ID_IN_USE',
          });
          return;
        }
      }

      // Build update object, converting datetime strings to Date objects
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.ocppVersion !== undefined) updateData.ocppVersion = body.ocppVersion;
      if (body.profileId !== undefined) updateData.profileId = body.profileId;
      if (body.profilePurpose !== undefined) updateData.profilePurpose = body.profilePurpose;
      if (body.profileKind !== undefined) updateData.profileKind = body.profileKind;
      if (body.recurrencyKind !== undefined) updateData.recurrencyKind = body.recurrencyKind;
      if (body.stackLevel !== undefined) updateData.stackLevel = body.stackLevel;
      if (body.evseId !== undefined) updateData.evseId = body.evseId;
      if (body.chargingRateUnit !== undefined) updateData.chargingRateUnit = body.chargingRateUnit;
      if (body.schedulePeriods !== undefined) updateData.schedulePeriods = body.schedulePeriods;
      if (body.startSchedule !== undefined)
        updateData.startSchedule = body.startSchedule ? new Date(body.startSchedule) : null;
      if (body.duration !== undefined) updateData.duration = body.duration;
      if (body.validFrom !== undefined)
        updateData.validFrom = body.validFrom ? new Date(body.validFrom) : null;
      if (body.validTo !== undefined)
        updateData.validTo = body.validTo ? new Date(body.validTo) : null;
      if (body.targetFilter !== undefined) updateData.targetFilter = body.targetFilter;

      try {
        const [updated] = await db
          .update(chargingProfileTemplates)
          .set(updateData)
          .where(eq(chargingProfileTemplates.id, id))
          .returning();

        if (updated != null) {
          const actor = getAuditActor(request);
          await writeAudit(
            { table: smartChargingTemplateAuditLog, idColumn: 'template_id' },
            {
              entityId: updated.id,
              entityIdSnapshot: updated.id,
              action: 'updated',
              ...actor,
              before: existing,
              after: updated,
            },
            db,
            request.log,
          );
        }

        return updated;
      } catch (err) {
        if (isProfileIdUniqueViolation(err)) {
          await reply.status(409).send({
            error: `profileId ${String(body.profileId)} is already used by another template`,
            code: 'PROFILE_ID_IN_USE',
          });
          return;
        }
        throw err;
      }
    },
  );

  // Duplicate template
  app.post(
    '/smart-charging/templates/:id/duplicate',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Duplicate a charging profile template',
        operationId: 'duplicateChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          201: itemResponse(templateItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [original] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (original == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      // Allocate a fresh profileId so each duplicate is uniquely addressable
      // when pushed to a station (OCPP profile.id is the per-station unique
      // key). Concurrent duplicates can compute the same max+1, so retry on
      // unique-violation, bumping until the insert succeeds. Bounded so a
      // pathological state can't loop forever.
      let nextProfileId: number;
      let duplicate: typeof chargingProfileTemplates.$inferSelect | undefined;
      const MAX_ALLOC_RETRIES = 10;
      for (let attempt = 0; attempt < MAX_ALLOC_RETRIES; attempt++) {
        const [maxRow] = await db
          .select({ maxId: max(chargingProfileTemplates.profileId) })
          .from(chargingProfileTemplates);
        nextProfileId = (maxRow?.maxId ?? 0) + 1 + attempt;
        try {
          const [row] = await db
            .insert(chargingProfileTemplates)
            .values({
              name: `${original.name} (Copy)`,
              description: original.description,
              ocppVersion: original.ocppVersion,
              profileId: nextProfileId,
              profilePurpose: original.profilePurpose,
              profileKind: original.profileKind,
              recurrencyKind: original.recurrencyKind,
              stackLevel: original.stackLevel,
              evseId: original.evseId,
              chargingRateUnit: original.chargingRateUnit,
              schedulePeriods: original.schedulePeriods,
              startSchedule: original.startSchedule,
              duration: original.duration,
              validFrom: original.validFrom,
              validTo: original.validTo,
              targetFilter: original.targetFilter,
            })
            .returning();
          duplicate = row;
          break;
        } catch (err) {
          if (!isProfileIdUniqueViolation(err)) throw err;
          // Lost the race; loop to recompute max and retry.
        }
      }
      if (duplicate == null) {
        await reply
          .status(409)
          .send({ error: 'Could not allocate a free profileId', code: 'PROFILE_ID_ALLOC_FAILED' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: smartChargingTemplateAuditLog, idColumn: 'template_id' },
        {
          entityId: duplicate.id,
          entityIdSnapshot: duplicate.id,
          action: 'created',
          ...actor,
          after: duplicate,
          notes: `Duplicated from ${id}`,
        },
        db,
        request.log,
      );

      return reply.status(201).send(duplicate);
    },
  );

  // Delete template
  app.delete(
    '/smart-charging/templates/:id',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Delete a charging profile template',
        operationId: 'deleteChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [existing] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      await db.delete(chargingProfileTemplates).where(eq(chargingProfileTemplates.id, id));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: smartChargingTemplateAuditLog, idColumn: 'template_id' },
        {
          entityId: null,
          entityIdSnapshot: id,
          action: 'deleted',
          ...actor,
          before: existing,
        },
        db,
        request.log,
      );

      return reply.status(204).send();
    },
  );

  // Preview matching stations
  app.get(
    '/smart-charging/templates/:id/matching-stations',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Preview stations matching the template target filter',
        operationId: 'listChargingProfileMatchingStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(matchingStationItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const ocppVersion = template.ocppVersion;
      const expectedProtocol = `ocpp${ocppVersion}`;

      const filter = template.targetFilter as Record<string, string> | null;
      const conditions = [
        eq(chargingStations.isOnline, true),
        eq(chargingStations.ocppProtocol, expectedProtocol),
      ];
      if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
      if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
      if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0)
        return { data: [], total: 0 };
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const whereClause = and(...conditions);

      const [data, countResult] = await Promise.all([
        db
          .select({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            model: chargingStations.model,
            siteName: sites.name,
            vendorName: vendors.name,
          })
          .from(chargingStations)
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(vendors, eq(chargingStations.vendorId, vendors.id))
          .where(whereClause)
          .orderBy(asc(chargingStations.stationId))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingStations).where(whereClause),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push to matching stations
  app.post(
    '/smart-charging/templates/:id/push',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Push charging profile template to matching stations via SetChargingProfile',
        operationId: 'pushChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          200: itemResponse(z.object({ success: z.boolean(), pushId: z.string() }).passthrough()),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const schedulePeriods = template.schedulePeriods as unknown[];
      if (schedulePeriods.length === 0) {
        return { success: true, pushId: '' };
      }

      const ocppVersion = template.ocppVersion;

      const { userId } = request.user as { userId: string };
      const targetStations = await resolveTemplateTargetStations(template, userId);
      if (targetStations.length === 0) {
        return { success: true, pushId: '' };
      }

      // Create push record
      const [push] = await db
        .insert(chargingProfilePushes)
        .values({
          templateId: id,
          status: 'active',
          stationCount: targetStations.length,
        })
        .returning();

      const pushId = push?.id ?? '';

      // Insert push station rows
      await db.insert(chargingProfilePushStations).values(
        targetStations.map((s) => ({
          pushId,
          stationId: s.id,
          status: 'pending' as const,
        })),
      );

      // Process in background. processChargingProfilePush has its own
      // try/catch and best-effort completion update, but attach an explicit
      // .catch() here so an unexpected rejection (OOM, downstream throw)
      // surfaces in logs instead of becoming an unhandledRejection that
      // could crash the worker.
      processChargingProfilePush(pushId, targetStations, template, ocppVersion).catch(
        (err: unknown) => {
          request.log.error({ err, pushId }, 'Charging profile push failed unexpectedly');
        },
      );

      const actor = getAuditActor(request);
      await writeAudit(
        { table: smartChargingTemplateAuditLog, idColumn: 'template_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'pushed',
          ...actor,
          notes: `Pushed to ${String(targetStations.length)} station(s)`,
        },
        db,
        request.log,
      );

      return { success: true, pushId };
    },
  );

  // Batch clear: send ClearChargingProfile to every station matching the
  // template's targetFilter. Mirrors push: same target resolution, same
  // tracking tables (rows tagged operation='clear').
  app.post(
    '/smart-charging/templates/:id/clear',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Clear charging profile from all matching stations',
        operationId: 'clearChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          200: itemResponse(z.object({ success: z.boolean(), pushId: z.string() }).passthrough()),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const ocppVersion = template.ocppVersion;

      const { userId } = request.user as { userId: string };
      const targetStations = await resolveTemplateTargetStations(template, userId);
      if (targetStations.length === 0) {
        return { success: true, pushId: '' };
      }

      const [push] = await db
        .insert(chargingProfilePushes)
        .values({
          templateId: id,
          operation: 'clear',
          status: 'active',
          stationCount: targetStations.length,
        })
        .returning();
      const pushId = push?.id ?? '';

      await db.insert(chargingProfilePushStations).values(
        targetStations.map((s) => ({
          pushId,
          stationId: s.id,
          status: 'pending' as const,
        })),
      );

      // Background dispatch with explicit .catch so an unexpected rejection
      // (downstream throw, OOM) surfaces in logs instead of becoming an
      // unhandledRejection that could crash the worker. Mirrors the push
      // path above.
      processChargingProfileClear(
        pushId,
        targetStations,
        {
          profilePurpose: template.profilePurpose,
          stackLevel: template.stackLevel,
          evseId: template.evseId,
        },
        ocppVersion,
      ).catch((err: unknown) => {
        request.log.error({ err, pushId }, 'Charging profile clear failed unexpectedly');
      });

      const actor = getAuditActor(request);
      // The smart_charging_template_audit_action enum only has
      // created/updated/deleted/pushed. Reuse 'pushed' for clear too — the
      // operation type lives on chargingProfilePushes.operation='clear' and
      // the notes here distinguish the intent for log readers.
      await writeAudit(
        { table: smartChargingTemplateAuditLog, idColumn: 'template_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'pushed',
          ...actor,
          notes: `Cleared from ${String(targetStations.length)} station(s)`,
        },
        db,
        request.log,
      );

      return { success: true, pushId };
    },
  );

  // Push history for a template
  app.get(
    '/smart-charging/templates/:id/pushes',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'List push history for a charging profile template',
        operationId: 'listChargingProfilePushes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(pushItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [template] = await db
        .select({ id: chargingProfileTemplates.id })
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [pushes, countResult] = await Promise.all([
        db
          .select()
          .from(chargingProfilePushes)
          .where(eq(chargingProfilePushes.templateId, id))
          .orderBy(desc(chargingProfilePushes.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: count() })
          .from(chargingProfilePushes)
          .where(eq(chargingProfilePushes.templateId, id)),
      ]);

      // One grouped query for all push IDs on this page replaces N parallel
      // per-push queries. The previous Promise.all hid the N+1 with
      // concurrency, but still consumed N pool slots and N round-trips for
      // data that lives in one table. WHERE pushId IN (...) + GROUP BY
      // pushId, status returns one row per (push, status); reduce into
      // a Map<pushId, counts> and stamp each push at render time.
      const pushIds = pushes.map((p) => p.id);
      const statusCountRows =
        pushIds.length > 0
          ? await db
              .select({
                pushId: chargingProfilePushStations.pushId,
                status: chargingProfilePushStations.status,
                count: count(),
              })
              .from(chargingProfilePushStations)
              .where(inArray(chargingProfilePushStations.pushId, pushIds))
              .groupBy(chargingProfilePushStations.pushId, chargingProfilePushStations.status)
          : [];

      const emptyCounts = (): Record<string, number> => ({
        pendingCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        failedCount: 0,
      });
      const countsByPush = new Map<string, Record<string, number>>();
      for (const row of statusCountRows) {
        const entry = countsByPush.get(row.pushId) ?? emptyCounts();
        entry[`${row.status}Count`] = row.count;
        countsByPush.set(row.pushId, entry);
      }

      const data = pushes.map((push) => ({
        ...push,
        ...(countsByPush.get(push.id) ?? emptyCounts()),
      }));

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push detail with per-station results
  app.get(
    '/smart-charging/pushes/:pushId',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Smart Charging'],
        summary: 'Get charging profile push detail with per-station results',
        operationId: 'getChargingProfilePushDetail',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ pushId: z.string().describe('Push ID') })),
        querystring: zodSchema(paginationQuery),
        response: {
          200: itemResponse(pushDetailItem),
          404: errorWith('Push not found', [ERROR_CODES.PUSH_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { pushId } = request.params as { pushId: string };
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [push] = await db
        .select()
        .from(chargingProfilePushes)
        .where(eq(chargingProfilePushes.id, pushId));
      if (push == null) {
        await reply.status(404).send({ error: 'Push not found', code: 'PUSH_NOT_FOUND' });
        return;
      }

      // Status counts and per-station rows hit the same table with no
      // inter-dependency - fetch in parallel to halve the wall-clock on
      // this detail view (polled every 3s while a push is active).
      const [statusCounts, stationRows] = await Promise.all([
        db
          .select({
            status: chargingProfilePushStations.status,
            count: count(),
          })
          .from(chargingProfilePushStations)
          .where(eq(chargingProfilePushStations.pushId, pushId))
          .groupBy(chargingProfilePushStations.status),
        db
          .select({
            id: chargingProfilePushStations.id,
            stationId: chargingProfilePushStations.stationId,
            stationName: chargingStations.stationId,
            status: chargingProfilePushStations.status,
            errorInfo: chargingProfilePushStations.errorInfo,
            updatedAt: chargingProfilePushStations.updatedAt,
          })
          .from(chargingProfilePushStations)
          .innerJoin(
            chargingStations,
            eq(chargingProfilePushStations.stationId, chargingStations.id),
          )
          .where(eq(chargingProfilePushStations.pushId, pushId))
          .orderBy(asc(chargingStations.stationId))
          .limit(limit)
          .offset(offset),
      ]);

      const counts: Record<string, number> = {
        acceptedCount: 0,
        rejectedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      };
      for (const row of statusCounts) {
        counts[`${row.status}Count`] = row.count;
      }

      return { ...push, ...counts, stations: stationRows, stationsTotal: push.stationCount };
    },
  );
}
