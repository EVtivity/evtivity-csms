// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The AI insights scope (Settings > AI > Automatic insights): which sites,
 * and inside them which stations, automatic insights and the AI workers
 * analyze. Company-wide like every AI setting: `settings.system:read` and
 * `settings.system:write` with access to every site (a site-restricted user
 * gets 404). Every write goes through `ai-insight-scope.service.ts`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_INSIGHT_SCOPE_MODES } from '@evtivity/lib/ai-insights';
import { authorize } from '../middleware/rbac.js';
import { rejectUnknownBodyKeys, zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import {
  AiInsightScopeError,
  readAiInsightScope,
  readAiInsightScopeStations,
  updateAiInsightScope,
} from '../services/ai-insight-scope.service.js';

const SETTING_NOT_FOUND = { error: 'Setting not found', code: 'SETTING_NOT_FOUND' } as const;

const modeField = z
  .enum(AI_INSIGHT_SCOPE_MODES)
  .describe(
    'all: every site and station, new ones included. selected: the selected sites and, inside them, the stations not turned off; a new site starts unselected and a new station follows its site',
  );

const scopeSite = z
  .object({
    id: z.string().describe('Site id'),
    name: z.string().describe('Site name'),
    selected: z
      .boolean()
      .describe('Selected for AI insights (every site is selected while the mode is all)'),
    stationCount: z.number().int().describe('Stations of the site'),
    stationsTurnedOff: z.number().int().describe('Stations of the site turned off on their own'),
  })
  .loose();

const scopeResponse = z
  .object({
    mode: modeField,
    sites: z.array(scopeSite).describe('Every site, by name'),
    stationsWithoutSite: z
      .number()
      .int()
      .describe('Stations without a site: in scope only while the mode is all'),
  })
  .loose()
  .describe('The AI insights scope');

const scopeStation = z
  .object({
    id: z.string().describe('Station id'),
    stationId: z.string().describe('OCPP identity of the station'),
    enabled: z
      .boolean()
      .describe('Not turned off: in scope while the mode is all or its site is selected'),
  })
  .loose();

const updateScopeBody = z.object({
  mode: modeField,
  sites: z
    .array(
      z.object({
        siteId: z.string().min(1).describe('Site id'),
        selected: z.boolean().describe('Select (true) or unselect (false) the site'),
      }),
    )
    .max(10_000)
    .optional()
    .describe('Sites to select or unselect (selected mode only); other sites keep their state'),
  stations: z
    .array(
      z.object({
        stationId: z.string().min(1).describe('Station id (not the OCPP identity)'),
        enabled: z.boolean().describe('Turn the station on (true) or off (false)'),
      }),
    )
    .max(50_000)
    .optional()
    .describe('Stations to turn on or off (selected mode only); other stations keep their state'),
});

const updateScopeResponse = z
  .object({
    scope: scopeResponse,
    sitesRemoved: z.number().int().describe('Sites that left the scope with this change'),
    stationsRemoved: z.number().int().describe('Stations that left the scope with this change'),
    insightsDismissed: z
      .number()
      .int()
      .describe('Open insights of what left the scope, now dismissed'),
    actionsExpired: z
      .number()
      .int()
      .describe('Waiting actions of what left the scope, now expired'),
  })
  .loose();

const siteParams = z.object({ siteId: z.string().describe('Site id') });

export function aiInsightScopeRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/ai/insights-scope',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get the AI insights scope',
        description:
          'Returns the scope mode and every site with its station counts. Users with access to every site only.',
        operationId: 'getAiInsightScope',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(scopeResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SETTING_NOT_FOUND))) return;
      return readAiInsightScope();
    },
  );

  app.get(
    '/settings/ai/insights-scope/sites/:siteId/stations',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'List the stations of a site in the AI insights scope',
        description:
          'Returns the stations of a site with whether each is turned on, by OCPP identity. Users with access to every site only.',
        operationId: 'listAiInsightScopeStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(z.array(scopeStation).describe('Stations of the site')),
          404: errorWith('Setting or site not found', [
            ERROR_CODES.SETTING_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SETTING_NOT_FOUND))) return;
      const { siteId } = request.params as z.infer<typeof siteParams>;
      const stations = await readAiInsightScopeStations(siteId);
      if (stations == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return stations;
    },
  );

  app.put(
    '/settings/ai/insights-scope',
    {
      onRequest: [authorize('settings.system:write')],
      preValidation: [rejectUnknownBodyKeys(updateScopeBody)],
      schema: {
        tags: ['Settings'],
        summary: 'Update the AI insights scope',
        description:
          'Sets the mode and, for selected, the sites to select or unselect and the stations to turn on or off (only the listed ones change). Switching to all selects every site and turns every station on. A site or station that leaves the scope gets no new insight or worker action; its open insights are dismissed and its waiting actions expire. Users with access to every site only.',
        operationId: 'updateAiInsightScope',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateScopeBody),
        response: {
          200: itemResponse(updateScopeResponse),
          400: errorWith(
            'Lists sent with mode all, an id listed twice, or an unknown id',
            [ERROR_CODES.VALIDATION_ERROR],
            {
              details: z
                .object({ ids: z.array(z.string()).describe('The ids at fault') })
                .optional(),
            },
          ),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof updateScopeBody>;
      try {
        return await updateAiInsightScope(body, getAuditActor(request), request.log);
      } catch (err) {
        if (!(err instanceof AiInsightScopeError)) throw err;
        await reply.status(400).send({
          error: err.message,
          code: 'VALIDATION_ERROR',
          ...(err.ids.length > 0 ? { details: { ids: err.ids } } : {}),
        });
        return;
      }
    },
  );
}
