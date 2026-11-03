// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The live OCPP messages of a site for the site layout window: the newest
// rows of the stored, masked OCPP message log of the site's stations. Same
// permission as a station's OCPP log (stations:read); the site scope of the
// caller decides the site, 404 outside it.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db, operatorStationSql } from '@evtivity/database';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import {
  SITE_OCPP_MESSAGES_DEFAULT,
  SITE_OCPP_MESSAGES_MAX,
  listSiteOcppMessages,
} from '../lib/site-ocpp-messages.js';

/** One open window polls every 2 s; this leaves room for a few tabs. */
export const SITE_OCPP_MESSAGES_RATE_LIMIT = 120;

const siteParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
});

const messagesQuery = z.object({
  stationId: ID_PARAMS.stationId
    .optional()
    .describe('Only this station of the site (charging_stations.id)'),
  after: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Only messages logged at or after this time (ISO 8601 with offset)'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SITE_OCPP_MESSAGES_MAX)
    .default(SITE_OCPP_MESSAGES_DEFAULT)
    .describe('Newest messages to return, oldest first in the reply'),
});

const messageItem = z
  .object({
    id: z.number().describe('Log row id'),
    stationId: z.string().describe('Station ID (charging_stations.id)'),
    stationOcppId: z.string().describe('OCPP station identity'),
    direction: z
      .string()
      .describe('Message direction (inbound = from station to CSMS, outbound = CSMS to station)'),
    messageType: z.number().describe('OCPP message type (2 = CALL, 3 = CALLRESULT, 4 = CALLERROR)'),
    messageId: z.string().nullable().describe('OCPP message id of the request and its response'),
    action: z.string().nullable().describe('OCPP action name'),
    payload: z.unknown().optional().describe('OCPP payload as stored, credentials masked'),
    errorCode: z.string().nullable().describe('OCPP error code (CALLERROR only)'),
    errorDescription: z.string().nullable().describe('OCPP error description (CALLERROR only)'),
    createdAt: z.coerce.date().describe('When the message was logged'),
  })
  .loose();

const messagesResponse = z
  .object({ data: z.array(messageItem).describe('Messages, oldest first') })
  .loose();

export function siteOcppMessageRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:id/ocpp-messages',
    {
      onRequest: [authorize('stations:read')],
      config: { rateLimit: { max: SITE_OCPP_MESSAGES_RATE_LIMIT, timeWindow: '1 minute' } },
      schema: {
        tags: ['Sites'],
        summary: 'List the live OCPP messages of a site',
        description:
          'The newest OCPP messages of the stations of a site, oldest first, as the station OCPP log stores them (credentials and URL passwords masked). Optional station filter and a since time for polling. 120 a minute.',
        operationId: 'getSiteOcppMessages',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(messagesQuery),
        response: {
          200: itemResponse(messagesResponse),
          404: errorWith('Site or station not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const query = parseZodRequest(messagesQuery, request.query);
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [site] = await db.execute<{ id: string }>(sql`SELECT id FROM sites WHERE id = ${id}`);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (query.stationId != null) {
        const [station] = await db.execute<{ id: string }>(sql`
          SELECT id FROM charging_stations
          WHERE id = ${query.stationId} AND site_id = ${id}
            AND ${sql.raw(operatorStationSql('charging_stations'))}
        `);
        if (station == null) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }
      const data = await listSiteOcppMessages({
        siteId: id,
        stationId: query.stationId,
        after: query.after != null ? new Date(query.after) : undefined,
        limit: query.limit,
      });
      return { data };
    },
  );
}
