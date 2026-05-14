// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { pricingHolidays, holidayAuditLog, writeAudit } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getPubSub } from '../lib/pubsub.js';
import { authorize } from '../middleware/rbac.js';

async function publishHolidayChanged(): Promise<void> {
  try {
    const pubsub = getPubSub();
    await pubsub.publish(
      'csms_events',
      JSON.stringify({ eventType: 'pricing.changed', action: 'holiday.changed' }),
    );
  } catch {
    // Non-critical
  }
}

const holidayItem = z
  .object({
    id: z.number().describe('Identifier'),
    name: z.string().describe('Holiday name'),
    date: z.string().describe('Holiday date in YYYY-MM-DD format'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
  })
  .passthrough();

const createHolidayBody = z.object({
  name: z.string().max(255).describe('Holiday name'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
    .describe('Holiday date'),
});

const bulkCreateBody = z.object({
  holidays: z
    .array(
      z.object({
        name: z.string().max(255),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
      }),
    )
    .min(1)
    .max(100),
});

const idParams = z.object({
  id: z.coerce.number().int().min(1).describe('Holiday ID'),
});

export function holidayRoutes(app: FastifyInstance): void {
  app.get(
    '/pricing-holidays',
    {
      onRequest: [authorize('pricing:read')],
      schema: {
        tags: ['Pricing'],
        summary: 'List all pricing holidays',
        operationId: 'listPricingHolidays',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(holidayItem) },
      },
    },
    async () => {
      return db.select().from(pricingHolidays);
    },
  );

  app.post(
    '/pricing-holidays',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Create a pricing holiday',
        operationId: 'createPricingHoliday',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createHolidayBody),
        response: {
          201: itemResponse(holidayItem),
          409: errorWith('Duplicate holiday', [ERROR_CODES.DUPLICATE_HOLIDAY]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createHolidayBody>;
      try {
        const [holiday] = await db.insert(pricingHolidays).values(body).returning();
        if (holiday != null) {
          const { userId } = request.user as { userId: string };
          await writeAudit(
            { table: holidayAuditLog, idColumn: 'holiday_id' },
            {
              entityId: String(holiday.id),
              entityIdSnapshot: String(holiday.id),
              action: 'created',
              actor: 'operator',
              actorUserId: userId,
              after: holiday,
            },
            db,
            request.log,
          );
        }
        await publishHolidayChanged();
        await reply.status(201).send(holiday);
      } catch (err: unknown) {
        const pgErr = err != null && typeof err === 'object' && 'cause' in err ? err.cause : err;
        if (
          pgErr != null &&
          typeof pgErr === 'object' &&
          'code' in pgErr &&
          String(pgErr.code) === '23505'
        ) {
          await reply.status(409).send({
            error: 'A holiday already exists for this date',
            code: 'DUPLICATE_HOLIDAY',
          });
          return;
        }
        throw err;
      }
    },
  );

  app.delete(
    '/pricing-holidays/:id',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Delete a pricing holiday',
        operationId: 'deletePricingHoliday',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Holiday not found', [ERROR_CODES.HOLIDAY_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParams>;
      const [existing] = await db.select().from(pricingHolidays).where(eq(pricingHolidays.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Holiday not found', code: 'HOLIDAY_NOT_FOUND' });
        return;
      }
      await db.delete(pricingHolidays).where(eq(pricingHolidays.id, id));
      const { userId } = request.user as { userId: string };
      await writeAudit(
        { table: holidayAuditLog, idColumn: 'holiday_id' },
        {
          entityId: String(id),
          entityIdSnapshot: String(id),
          action: 'deleted',
          actor: 'operator',
          actorUserId: userId,
          before: existing,
        },
        db,
        request.log,
      );
      await publishHolidayChanged();
      await reply.status(204).send();
    },
  );

  app.post(
    '/pricing-holidays/bulk',
    {
      onRequest: [authorize('pricing:write')],
      schema: {
        tags: ['Pricing'],
        summary: 'Bulk create pricing holidays',
        operationId: 'bulkCreatePricingHolidays',
        security: [{ bearerAuth: [] }],
        body: zodSchema(bulkCreateBody),
        response: { 201: arrayResponse(holidayItem) },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof bulkCreateBody>;
      const result = await db
        .insert(pricingHolidays)
        .values(body.holidays)
        .onConflictDoNothing()
        .returning();
      if (result.length > 0) {
        const { userId } = request.user as { userId: string };
        for (const h of result) {
          await writeAudit(
            { table: holidayAuditLog, idColumn: 'holiday_id' },
            {
              entityId: String(h.id),
              entityIdSnapshot: String(h.id),
              action: 'created',
              actor: 'operator',
              actorUserId: userId,
              after: h,
              notes: 'bulk import',
            },
            db,
            request.log,
          );
        }
        await publishHolidayChanged();
      }
      await reply.status(201).send(result);
    },
  );
}
