// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, count } from 'drizzle-orm';
import { db, eventAlertRules } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
} from '../lib/response-schemas.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';

const ruleItem = z
  .object({
    id: z.number(),
    component: z.string(),
    variable: z.string(),
    minSeverity: z.number(),
    isEnabled: z.boolean(),
    notifyChannel: z.string(),
    notifyRecipient: z.string(),
  })
  .passthrough();

const createRuleBody = z.object({
  component: z.string().min(1).max(100).describe('OCPP component name'),
  variable: z.string().min(1).max(100).describe('OCPP variable name'),
  minSeverity: z.number().int().min(0).max(9).default(0).describe('Minimum severity (0=Danger)'),
  isEnabled: z.boolean().default(true),
  notifyChannel: z.string().max(50).default('email'),
  notifyRecipient: z.string().max(500).default('$admin'),
});

const updateRuleBody = z.object({
  minSeverity: z.number().int().min(0).max(9).optional(),
  isEnabled: z.boolean().optional(),
  notifyChannel: z.string().max(50).optional(),
  notifyRecipient: z.string().max(500).optional(),
});

const ruleIdParams = z.object({
  id: z.coerce.number().int().describe('Alert rule ID'),
});

export function eventAlertRuleRoutes(app: FastifyInstance): void {
  app.get('/event-alert-rules', {
    onRequest: [authorize('stations:read')],
    schema: {
      tags: ['Stations'],
      summary: 'List event alert rules',
      operationId: 'listEventAlertRules',
      security: [{ bearerAuth: [] }],
      querystring: zodSchema(paginationQuery),
      response: { 200: paginatedResponse(ruleItem) },
    },
    handler: async (request) => {
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const [rows, [totalRow]] = await Promise.all([
        db.select().from(eventAlertRules).limit(limit).offset(offset),
        db.select({ count: count() }).from(eventAlertRules),
      ]);

      return { data: rows, total: totalRow?.count ?? 0 } satisfies PaginatedResponse<unknown>;
    },
  });

  app.post('/event-alert-rules', {
    onRequest: [authorize('stations:write')],
    schema: {
      tags: ['Stations'],
      summary: 'Create event alert rule',
      operationId: 'createEventAlertRule',
      security: [{ bearerAuth: [] }],
      body: zodSchema(createRuleBody),
      response: { 201: itemResponse(ruleItem), 400: errorResponse },
    },
    handler: async (request, reply) => {
      const body = request.body as z.infer<typeof createRuleBody>;
      const [rule] = await db.insert(eventAlertRules).values(body).returning();
      return reply.status(201).send(rule);
    },
  });

  app.patch('/event-alert-rules/:id', {
    onRequest: [authorize('stations:write')],
    schema: {
      tags: ['Stations'],
      summary: 'Update event alert rule',
      operationId: 'updateEventAlertRule',
      security: [{ bearerAuth: [] }],
      params: zodSchema(ruleIdParams),
      body: zodSchema(updateRuleBody),
      response: { 200: itemResponse(ruleItem), 404: errorResponse },
    },
    handler: async (request, reply) => {
      const { id } = request.params as z.infer<typeof ruleIdParams>;
      const body = request.body as z.infer<typeof updateRuleBody>;

      const [updated] = await db
        .update(eventAlertRules)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(eventAlertRules.id, id))
        .returning();

      if (updated == null) {
        return reply.status(404).send({ error: 'Rule not found', code: 'RULE_NOT_FOUND' });
      }
      return updated;
    },
  });

  app.delete('/event-alert-rules/:id', {
    onRequest: [authorize('stations:write')],
    schema: {
      tags: ['Stations'],
      summary: 'Delete event alert rule',
      operationId: 'deleteEventAlertRule',
      security: [{ bearerAuth: [] }],
      params: zodSchema(ruleIdParams),
      response: { 200: successResponse, 404: errorResponse },
    },
    handler: async (request, reply) => {
      const { id } = request.params as z.infer<typeof ruleIdParams>;

      const [deleted] = await db
        .delete(eventAlertRules)
        .where(eq(eventAlertRules.id, id))
        .returning({ id: eventAlertRules.id });

      if (deleted == null) {
        return reply.status(404).send({ error: 'Rule not found', code: 'RULE_NOT_FOUND' });
      }
      return { success: true as const };
    },
  });
}
