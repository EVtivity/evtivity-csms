// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Handlebars from 'handlebars';
import { db, stationMessageTemplates } from '@evtivity/database';
import {
  STATION_MESSAGE_DEFAULTS,
  clearStationMessageCache,
  type StationMessageState,
} from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';

const STATION_MESSAGE_STATES = [
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
] as const satisfies readonly StationMessageState[];

const stateEnum = z.enum(STATION_MESSAGE_STATES);

const stateParams = z.object({
  state: stateEnum.describe('Station message state'),
});

const updateBody = z.object({
  body: z.string().min(1).max(5000).describe('Handlebars template body'),
});

const previewBody = z.object({
  state: stateEnum.describe('Station message state'),
  body: z.string().min(1).max(5000).describe('Handlebars template body to render'),
  sampleContext: z.record(z.string().max(1000)).optional().describe('Variable overrides'),
});

const templateItem = z
  .object({
    state: stateEnum.describe('Station operating state the template renders for'),
    body: z.string().max(5000).describe('Handlebars template body sent to the station display'),
    updatedAt: z.coerce.date().nullable().describe('Timestamp of the most recent edit'),
    updatedBy: z.string().nullable().describe('Operator user ID who last edited the template'),
  })
  .passthrough();

const previewItem = z
  .object({
    rendered: z.string().describe('Compiled template output using sample context values'),
  })
  .passthrough();

const DEFAULT_SAMPLE_CONTEXT: Record<string, string> = {
  companyName: 'EVtivity',
  stationOcppId: 'CS-1234',
  pricingDisplay: '$0.30/kWh + $0.02/min',
  energyKwh: '12.4',
  powerKw: '22.0',
  costFormatted: '$3.42',
  elapsedFormatted: '12m',
  idleFeeRate: '$0.10/min',
  supportPhone: '+1-555-0100',
  driverFirstName: 'Alex',
  reservationExpiresAt: '3:45 PM',
};

export function stationMessageTemplateRoutes(app: FastifyInstance): void {
  app.get(
    '/station-message-templates',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'List all station message templates',
        operationId: 'listStationMessageTemplates',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.object({ data: z.array(templateItem) }).passthrough()) },
      },
    },
    async () => {
      const rows = await db
        .select({
          state: stationMessageTemplates.state,
          body: stationMessageTemplates.body,
          updatedAt: stationMessageTemplates.updatedAt,
          updatedBy: stationMessageTemplates.updatedBy,
        })
        .from(stationMessageTemplates);

      return { data: rows };
    },
  );

  app.put(
    '/station-message-templates/:state',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Upsert a station message template body',
        operationId: 'updateStationMessageTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stateParams),
        body: zodSchema(updateBody),
        response: {
          200: itemResponse(templateItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { state } = request.params as z.infer<typeof stateParams>;
      const { body } = request.body as z.infer<typeof updateBody>;
      const jwtUser = request.user as unknown as JwtPayload;
      const userId = typeof jwtUser.userId === 'string' ? jwtUser.userId : null;

      const updatedAt = new Date();
      const [row] = await db
        .insert(stationMessageTemplates)
        .values({ state, body, updatedAt, updatedBy: userId })
        .onConflictDoUpdate({
          target: stationMessageTemplates.state,
          set: { body, updatedAt, updatedBy: userId },
        })
        .returning({
          state: stationMessageTemplates.state,
          body: stationMessageTemplates.body,
          updatedAt: stationMessageTemplates.updatedAt,
          updatedBy: stationMessageTemplates.updatedBy,
        });

      if (row == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      clearStationMessageCache();
      return row;
    },
  );

  app.delete(
    '/station-message-templates/:state',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Reset a station message template to its seed default',
        operationId: 'resetStationMessageTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stateParams),
        response: { 200: itemResponse(templateItem) },
      },
    },
    async (request) => {
      const { state } = request.params as z.infer<typeof stateParams>;
      const defaultBody = STATION_MESSAGE_DEFAULTS[state];

      const jwtUser = request.user as unknown as JwtPayload;
      const userId = typeof jwtUser.userId === 'string' ? jwtUser.userId : null;
      const updatedAt = new Date();

      const [row] = await db
        .insert(stationMessageTemplates)
        .values({ state, body: defaultBody, updatedAt, updatedBy: userId })
        .onConflictDoUpdate({
          target: stationMessageTemplates.state,
          set: { body: defaultBody, updatedAt, updatedBy: userId },
        })
        .returning({
          state: stationMessageTemplates.state,
          body: stationMessageTemplates.body,
          updatedAt: stationMessageTemplates.updatedAt,
          updatedBy: stationMessageTemplates.updatedBy,
        });

      clearStationMessageCache();
      return row;
    },
  );

  app.post(
    '/station-message-templates/preview',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Render a station message template body with sample variables',
        operationId: 'previewStationMessageTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(previewBody),
        response: { 200: itemResponse(previewItem) },
      },
    },
    (request) => {
      const { body, sampleContext } = request.body as z.infer<typeof previewBody>;

      const ctx: Record<string, string> = { ...DEFAULT_SAMPLE_CONTEXT };
      if (sampleContext != null) {
        for (const [key, value] of Object.entries(sampleContext)) {
          if (typeof value === 'string') ctx[key] = value;
        }
      }

      let rendered: string;
      try {
        const template = Handlebars.compile(body, { noEscape: true });
        rendered = template(ctx);
      } catch {
        rendered = '';
      }

      return Promise.resolve({ rendered });
    },
  );
}
