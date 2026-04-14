// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, ne, count } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { pricingGroups, tariffs, pricingHolidays, chargingSessions } from '@evtivity/database';
import {
  tariffRestrictionsSchema,
  derivePriority,
  validateNoOverlap,
  resolveActiveTariff,
} from '@evtivity/lib';
import type { TariffRestrictions, TariffWithRestrictions } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { errorResponse, itemResponse, arrayResponse } from '../lib/response-schemas.js';
import { resolveTariffGroup } from '../services/tariff.service.js';
import { authorize } from '../middleware/rbac.js';

const pricingGroupItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isDefault: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const tariffItem = z
  .object({
    id: z.string(),
    pricingGroupId: z.string(),
    name: z.string(),
    currency: z.string(),
    pricePerKwh: z.string().nullable(),
    pricePerMinute: z.string().nullable(),
    pricePerSession: z.string().nullable(),
    isActive: z.boolean(),
    idleFeePricePerMinute: z.string().nullable(),
    taxRate: z.string().nullable(),
    restrictions: z.unknown().nullable(),
    reservationFeePerMinute: z.string().nullable(),
    priority: z.number(),
    isDefault: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const scheduleItem = z
  .object({
    id: z.string(),
    name: z.string(),
    currency: z.string(),
    pricePerKwh: z.string().nullable(),
    pricePerMinute: z.string().nullable(),
    pricePerSession: z.string().nullable(),
    idleFeePricePerMinute: z.string().nullable(),
    taxRate: z.string().nullable(),
    restrictions: z.unknown().nullable(),
    priority: z.number(),
    isDefault: z.boolean(),
    isCurrent: z.boolean(),
  })
  .passthrough();

const activeTariffItem = z
  .object({
    id: z.string(),
    name: z.string(),
    currency: z.string(),
    pricePerKwh: z.string().nullable(),
    pricePerMinute: z.string().nullable(),
    pricePerSession: z.string().nullable(),
    idleFeePricePerMinute: z.string().nullable(),
    taxRate: z.string().nullable(),
    restrictions: z.unknown().nullable(),
    priority: z.number(),
    isDefault: z.boolean(),
    pricingGroupId: z.string(),
    pricingGroupName: z.string(),
  })
  .passthrough();

const groupParams = z.object({
  id: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const tariffParams = z.object({
  id: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
  tariffId: ID_PARAMS.tariffId.describe('Tariff ID'),
});

const stationParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
});

const nonNegativePrice = z.string().refine((val) => !isNaN(Number(val)) && Number(val) >= 0, {
  message: 'Price must be a non-negative number',
});

const createGroupBody = z.object({
  name: z.string().max(255),
  description: z.string().max(500).optional(),
  isDefault: z.boolean().optional().describe('Whether this is the default pricing group'),
});

const createTariffBody = z.object({
  name: z.string().max(255),
  currency: z.string().length(3).default('USD').describe('ISO 4217 currency code'),
  pricePerKwh: nonNegativePrice.optional().describe('Price per kWh as a decimal string'),
  pricePerMinute: nonNegativePrice.optional().describe('Price per minute as a decimal string'),
  pricePerSession: nonNegativePrice.optional().describe('Flat fee per session as a decimal string'),
  isActive: z.boolean().default(true).describe('Whether the tariff is active'),
  idleFeePricePerMinute: nonNegativePrice
    .optional()
    .describe('Idle fee per minute as a decimal string'),
  taxRate: nonNegativePrice.optional().describe('Tax rate as a decimal (e.g. 0.08 for 8%)'),
  restrictions: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe('Tariff restrictions (time-of-day, etc.)'),
  isDefault: z.boolean().optional().describe('Whether this is the default tariff for the group'),
});

const updateGroupBody = z.object({
  name: z.string().max(255).optional(),
  description: z.string().max(500).nullable().optional(),
});

const nullableNonNegativePrice = nonNegativePrice.nullable();

const updateTariffBody = z.object({
  name: z.string().max(255).optional(),
  pricePerKwh: nullableNonNegativePrice.optional().describe('Price per kWh; null to clear'),
  pricePerMinute: nullableNonNegativePrice.optional().describe('Price per minute; null to clear'),
  pricePerSession: nullableNonNegativePrice
    .optional()
    .describe('Flat fee per session; null to clear'),
  isActive: z.boolean().optional().describe('Whether the tariff is active'),
  idleFeePricePerMinute: nullableNonNegativePrice
    .optional()
    .describe('Idle fee per minute; null to clear'),
  taxRate: nullableNonNegativePrice.optional().describe('Tax rate; null to clear'),
  restrictions: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe('Tariff restrictions; null to clear'),
  isDefault: z.boolean().optional().describe('Whether this is the default tariff for the group'),
});

async function loadHolidays(): Promise<Date[]> {
  const rows = await db.select({ date: pricingHolidays.date }).from(pricingHolidays);
  return rows.map((r) => new Date(r.date));
}

export function pricingRoutes(app: FastifyInstance): void {
  // Pricing Groups CRUD
  app.get(
    '/pricing-groups',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'List all pricing groups',
        operationId: 'listPricingGroups',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(pricingGroupItem) },
      },
    },
    async () => {
      return db.select().from(pricingGroups);
    },
  );

  app.get(
    '/pricing-groups/:id',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'Get a pricing group by ID',
        operationId: 'getPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(groupParams),
        response: { 200: itemResponse(pricingGroupItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof groupParams>;
      const [group] = await db.select().from(pricingGroups).where(eq(pricingGroups.id, id));
      if (group == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }
      return group;
    },
  );

  app.post(
    '/pricing-groups',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Create a pricing group',
        operationId: 'createPricingGroup',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createGroupBody),
        response: { 201: itemResponse(pricingGroupItem) },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createGroupBody>;
      const [group] = await db.insert(pricingGroups).values(body).returning();
      await reply.status(201).send(group);
    },
  );

  app.patch(
    '/pricing-groups/:id',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Update a pricing group',
        operationId: 'updatePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(groupParams),
        body: zodSchema(updateGroupBody),
        response: { 200: itemResponse(pricingGroupItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof groupParams>;
      const body = request.body as z.infer<typeof updateGroupBody>;

      const [existing] = await db.select().from(pricingGroups).where(eq(pricingGroups.id, id));
      if (existing == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }

      const [updated] = await db
        .update(pricingGroups)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(pricingGroups.id, id))
        .returning();
      return updated;
    },
  );

  app.delete(
    '/pricing-groups/:id',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Delete a pricing group and its tariffs',
        operationId: 'deletePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(groupParams),
        response: { 204: { type: 'null' as const }, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof groupParams>;

      const [group] = await db.select().from(pricingGroups).where(eq(pricingGroups.id, id));
      if (group == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }

      const [usage] = await db
        .select({ count: count() })
        .from(chargingSessions)
        .innerJoin(tariffs, eq(chargingSessions.tariffId, tariffs.id))
        .where(eq(tariffs.pricingGroupId, id));
      if (usage != null && usage.count > 0) {
        await reply.status(409).send({
          error: 'Pricing group has tariffs referenced by charging sessions',
          code: 'PRICING_GROUP_TARIFFS_IN_USE',
        });
        return;
      }

      await db.delete(tariffs).where(eq(tariffs.pricingGroupId, id));
      await db.delete(pricingGroups).where(eq(pricingGroups.id, id));

      await reply.status(204).send();
    },
  );

  // Tariff CRUD
  app.get(
    '/pricing-groups/:id/tariffs',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'List tariffs in a pricing group',
        operationId: 'listGroupTariffs',
        security: [{ bearerAuth: [] }],
        params: zodSchema(groupParams),
        response: { 200: arrayResponse(tariffItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof groupParams>;
      return db.select().from(tariffs).where(eq(tariffs.pricingGroupId, id));
    },
  );

  app.get(
    '/pricing-groups/:id/tariffs/:tariffId',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'Get a single tariff',
        operationId: 'getGroupTariff',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tariffParams),
        response: { 200: itemResponse(tariffItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { tariffId } = request.params as z.infer<typeof tariffParams>;
      const [tariff] = await db.select().from(tariffs).where(eq(tariffs.id, tariffId));
      if (tariff == null) {
        await reply.status(404).send({ error: 'Tariff not found', code: 'TARIFF_NOT_FOUND' });
        return;
      }
      return tariff;
    },
  );

  app.post(
    '/pricing-groups/:id/tariffs',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Create a tariff in a pricing group',
        operationId: 'createGroupTariff',
        security: [{ bearerAuth: [] }],
        params: zodSchema(groupParams),
        body: zodSchema(createTariffBody),
        response: {
          201: itemResponse(tariffItem),
          400: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof groupParams>;
      const body = request.body as z.infer<typeof createTariffBody>;

      // Validate restrictions
      const restrictions = body.restrictions as TariffRestrictions | null | undefined;
      if (restrictions != null) {
        const parsed = tariffRestrictionsSchema.safeParse(restrictions);
        if (!parsed.success) {
          await reply.status(400).send({
            error: parsed.error.issues.map((i) => i.message).join('; '),
            code: 'INVALID_RESTRICTIONS',
          });
          return;
        }
      }

      const priority = derivePriority(restrictions ?? null);
      const isDefault = body.isDefault ?? priority === 0;

      // Check for existing tariffs in this group for overlap validation
      const existingTariffs = await db
        .select({
          id: tariffs.id,
          restrictions: tariffs.restrictions,
          priority: tariffs.priority,
          isDefault: tariffs.isDefault,
        })
        .from(tariffs)
        .where(and(eq(tariffs.pricingGroupId, id), eq(tariffs.isActive, true)));

      const overlapCheck = validateNoOverlap(
        existingTariffs.map((t) => ({
          id: t.id,
          restrictions: t.restrictions as TariffRestrictions | null,
          priority: t.priority,
        })),
        restrictions ?? null,
        priority,
      );

      if (!overlapCheck.valid) {
        await reply.status(409).send({
          error: overlapCheck.message ?? 'Tariff overlap detected',
          code: 'TARIFF_OVERLAP',
          conflictingTariffId: overlapCheck.conflictingTariffId,
        });
        return;
      }

      // If setting as default, unset any other default in the group
      if (isDefault) {
        await db
          .update(tariffs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(tariffs.pricingGroupId, id), eq(tariffs.isDefault, true)));
      }

      // Auto-set isDefault if this is the first tariff in the group
      const hasDefault = existingTariffs.some((t) => t.isDefault);
      const finalIsDefault = isDefault || !hasDefault;

      const [tariff] = await db
        .insert(tariffs)
        .values({
          pricingGroupId: id,
          name: body.name,
          currency: body.currency,
          pricePerKwh: body.pricePerKwh,
          pricePerMinute: body.pricePerMinute,
          pricePerSession: body.pricePerSession,
          isActive: body.isActive,
          idleFeePricePerMinute: body.idleFeePricePerMinute,
          taxRate: body.taxRate,
          restrictions: restrictions ?? null,
          priority,
          isDefault: finalIsDefault,
        })
        .returning();
      await reply.status(201).send(tariff);
    },
  );

  app.patch(
    '/pricing-groups/:id/tariffs/:tariffId',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Update a tariff',
        operationId: 'updateGroupTariff',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tariffParams),
        body: zodSchema(updateTariffBody),
        response: {
          200: itemResponse(tariffItem),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, tariffId } = request.params as z.infer<typeof tariffParams>;
      const body = request.body as z.infer<typeof updateTariffBody>;

      const [existing] = await db.select().from(tariffs).where(eq(tariffs.id, tariffId));
      if (existing == null) {
        await reply.status(404).send({ error: 'Tariff not found', code: 'TARIFF_NOT_FOUND' });
        return;
      }

      // Validate restrictions if being updated
      const restrictions =
        body.restrictions !== undefined
          ? (body.restrictions as TariffRestrictions | null)
          : (existing.restrictions as TariffRestrictions | null);

      if (restrictions != null) {
        const parsed = tariffRestrictionsSchema.safeParse(restrictions);
        if (!parsed.success) {
          await reply.status(400).send({
            error: parsed.error.issues.map((i) => i.message).join('; '),
            code: 'INVALID_RESTRICTIONS',
          });
          return;
        }
      }

      const priority = derivePriority(restrictions);

      // Overlap validation
      const existingTariffs = await db
        .select({
          id: tariffs.id,
          restrictions: tariffs.restrictions,
          priority: tariffs.priority,
        })
        .from(tariffs)
        .where(and(eq(tariffs.pricingGroupId, id), eq(tariffs.isActive, true)));

      const overlapCheck = validateNoOverlap(
        existingTariffs.map((t) => ({
          id: t.id,
          restrictions: t.restrictions as TariffRestrictions | null,
          priority: t.priority,
        })),
        restrictions,
        priority,
        tariffId,
      );

      if (!overlapCheck.valid) {
        await reply.status(409).send({
          error: overlapCheck.message ?? 'Tariff overlap detected',
          code: 'TARIFF_OVERLAP',
          conflictingTariffId: overlapCheck.conflictingTariffId,
        });
        return;
      }

      // Handle isDefault flag
      const isDefault = body.isDefault ?? existing.isDefault;
      if (isDefault && !existing.isDefault) {
        await db
          .update(tariffs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(tariffs.pricingGroupId, existing.pricingGroupId),
              eq(tariffs.isDefault, true),
              ne(tariffs.id, tariffId),
            ),
          );
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData['name'] = body.name;
      if (body.pricePerKwh !== undefined) updateData['pricePerKwh'] = body.pricePerKwh;
      if (body.pricePerMinute !== undefined) updateData['pricePerMinute'] = body.pricePerMinute;
      if (body.pricePerSession !== undefined) updateData['pricePerSession'] = body.pricePerSession;
      if (body.isActive !== undefined) updateData['isActive'] = body.isActive;
      if (body.idleFeePricePerMinute !== undefined)
        updateData['idleFeePricePerMinute'] = body.idleFeePricePerMinute;
      if (body.taxRate !== undefined) updateData['taxRate'] = body.taxRate;
      if (body.restrictions !== undefined) {
        updateData['restrictions'] = body.restrictions;
        updateData['priority'] = priority;
      }
      updateData['isDefault'] = isDefault;

      const [updated] = await db
        .update(tariffs)
        .set(updateData)
        .where(eq(tariffs.id, tariffId))
        .returning();
      return updated;
    },
  );

  app.delete(
    '/pricing-groups/:id/tariffs/:tariffId',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Delete a tariff from a pricing group',
        operationId: 'deleteGroupTariff',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tariffParams),
        response: { 204: { type: 'null' as const }, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { tariffId } = request.params as z.infer<typeof tariffParams>;

      const [tariff] = await db.select().from(tariffs).where(eq(tariffs.id, tariffId));
      if (tariff == null) {
        await reply.status(404).send({ error: 'Tariff not found', code: 'TARIFF_NOT_FOUND' });
        return;
      }

      const [usage] = await db
        .select({ count: count() })
        .from(chargingSessions)
        .where(eq(chargingSessions.tariffId, tariffId));
      if (usage != null && usage.count > 0) {
        await reply.status(409).send({
          error: 'Tariff is referenced by charging sessions and cannot be deleted',
          code: 'TARIFF_IN_USE',
        });
        return;
      }

      await db.delete(tariffs).where(eq(tariffs.id, tariffId));
      await reply.status(204).send();
    },
  );

  // Schedule endpoint
  app.get(
    '/pricing-groups/:id/schedule',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'Get tariff schedule for a pricing group',
        operationId: 'getPricingGroupSchedule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(groupParams),
        response: { 200: arrayResponse(scheduleItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof groupParams>;

      const [group] = await db.select().from(pricingGroups).where(eq(pricingGroups.id, id));
      if (group == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }

      const activeTariffs = await db
        .select()
        .from(tariffs)
        .where(and(eq(tariffs.pricingGroupId, id), eq(tariffs.isActive, true)));

      const holidays = await loadHolidays();
      const now = new Date();

      const tariffInputs: TariffWithRestrictions[] = activeTariffs.map((t) => ({
        id: t.id,
        currency: t.currency,
        pricePerKwh: t.pricePerKwh,
        pricePerMinute: t.pricePerMinute,
        pricePerSession: t.pricePerSession,
        idleFeePricePerMinute: t.idleFeePricePerMinute,
        reservationFeePerMinute: t.reservationFeePerMinute,
        taxRate: t.taxRate,
        restrictions: t.restrictions as TariffRestrictions | null,
        priority: t.priority,
        isDefault: t.isDefault,
      }));

      const currentTariff = resolveActiveTariff(tariffInputs, now, holidays, 0);

      const schedule = activeTariffs
        .map((t) => ({
          id: t.id,
          name: t.name,
          currency: t.currency,
          pricePerKwh: t.pricePerKwh,
          pricePerMinute: t.pricePerMinute,
          pricePerSession: t.pricePerSession,
          idleFeePricePerMinute: t.idleFeePricePerMinute,
          taxRate: t.taxRate,
          restrictions: t.restrictions,
          priority: t.priority,
          isDefault: t.isDefault,
          isCurrent: currentTariff?.id === t.id,
        }))
        .sort((a, b) => b.priority - a.priority);

      return schedule;
    },
  );

  // Station active tariff endpoint
  app.get(
    '/stations/:id/active-tariff',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'Get the currently active tariff for a station',
        operationId: 'getStationActiveTariff',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: itemResponse(activeTariffItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;

      const result = await resolveTariffGroup(id);
      if (result == null) {
        await reply
          .status(404)
          .send({ error: 'No pricing group found for station', code: 'NO_PRICING_GROUP' });
        return;
      }

      const activeTariffs = await db
        .select()
        .from(tariffs)
        .where(and(eq(tariffs.pricingGroupId, result.groupId), eq(tariffs.isActive, true)));

      if (activeTariffs.length === 0) {
        await reply.status(404).send({ error: 'No active tariffs found', code: 'NO_TARIFFS' });
        return;
      }

      const holidays = await loadHolidays();
      const now = new Date();

      const tariffInputs: TariffWithRestrictions[] = activeTariffs.map((t) => ({
        id: t.id,
        currency: t.currency,
        pricePerKwh: t.pricePerKwh,
        pricePerMinute: t.pricePerMinute,
        pricePerSession: t.pricePerSession,
        idleFeePricePerMinute: t.idleFeePricePerMinute,
        reservationFeePerMinute: t.reservationFeePerMinute,
        taxRate: t.taxRate,
        restrictions: t.restrictions as TariffRestrictions | null,
        priority: t.priority,
        isDefault: t.isDefault,
      }));

      const current = resolveActiveTariff(tariffInputs, now, holidays, 0);
      if (current == null) {
        await reply
          .status(404)
          .send({ error: 'No matching tariff for current time', code: 'NO_MATCHING_TARIFF' });
        return;
      }

      const match = activeTariffs.find((t) => t.id === current.id);

      return {
        ...current,
        name: match?.name ?? '',
        pricingGroupId: result.groupId,
        pricingGroupName: result.groupName,
      };
    },
  );
}
