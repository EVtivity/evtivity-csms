// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { pricingHolidays } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse, arrayResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';

const holidayItem = z
  .object({
    id: z.number(),
    name: z.string(),
    date: z.string(),
    createdAt: z.coerce.date(),
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
        response: { 201: itemResponse(holidayItem), 409: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createHolidayBody>;
      try {
        const [holiday] = await db.insert(pricingHolidays).values(body).returning();
        await reply.status(201).send(holiday);
      } catch (err: unknown) {
        const pgErr =
          err != null && typeof err === 'object' && 'cause' in err
            ? (err as { cause: unknown }).cause
            : err;
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
        response: { 204: { type: 'null' as const }, 404: errorResponse },
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
      await reply.status(201).send(result);
    },
  );
}
