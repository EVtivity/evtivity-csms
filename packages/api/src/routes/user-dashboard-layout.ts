// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Live dashboard layout of the signed-in user: chart order and
// visibility (the stat cards are fixed), and the site of the 3D site layout
// widget, kept only while the user may access it. A preference of the user, so signed-in
// sessions only (no API keys) and no audit row. Every write goes through the
// one writer in `@evtivity/database` (`lib/dashboard-layout.ts`).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteUserDashboardLayout,
  existingDashboardSiteIds,
  getUserDashboardLayout,
  saveUserDashboardLayout,
} from '@evtivity/database';
import {
  DASHBOARD_LAYOUT_MAX_ITEMS,
  DASHBOARD_SITE_ID_MAX_LENGTH,
  DASHBOARD_WIDGET_ID_MAX_LENGTH,
  dashboardLayoutProblem,
  defaultDashboardLayout,
  resolveDashboardLayout,
  type DashboardLayout,
} from '@evtivity/lib/dashboard-layout';
import type { JwtPayload } from '../plugins/auth.js';
import { selfService } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';

const layoutItem = z
  .object({
    id: z
      .string()
      .max(DASHBOARD_WIDGET_ID_MAX_LENGTH)
      .describe('Chart widget id, such as chart.energy'),
    hidden: z.boolean().describe('True when the user hid the widget'),
    siteId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'The site the widget shows (3D site layout only); null or absent for the default site',
      ),
    siteUnavailable: z
      .boolean()
      .optional()
      .describe(
        'True when the chosen site was deleted or is no longer accessible; siteId is then null and the default site shows',
      ),
  })
  .loose();

const layoutBody = z.object({
  version: z.literal(1).describe('Layout format version'),
  charts: z
    .array(
      z.object({
        id: z.string().max(DASHBOARD_WIDGET_ID_MAX_LENGTH).describe('Chart widget id'),
        hidden: z.boolean().describe('True to hide the chart'),
        siteId: z
          .string()
          .min(1)
          .max(DASHBOARD_SITE_ID_MAX_LENGTH)
          .nullable()
          .optional()
          .describe(
            'The site the widget shows, only on chart.siteLayout3d; must be a site the user may access. Null for the default site',
          ),
      }),
    )
    .max(DASHBOARD_LAYOUT_MAX_ITEMS)
    .describe(
      'Charts in display order. Charts left out are appended in the default order; the 3D site layout goes above the map',
    ),
});

const layoutResponse = z
  .object({
    layout: z
      .object({
        version: z.literal(1).describe('Layout format version'),
        charts: z.array(layoutItem).describe('Every chart widget, in display order'),
      })
      .loose()
      .describe(
        'The layout to render: every known chart once, new charts appended with their default visibility',
      ),
    customized: z
      .boolean()
      .describe('True when the user saved a layout, false for the default layout'),
  })
  .loose();

type LayoutReplyItem = DashboardLayout['charts'][number] & { siteUnavailable?: true };

/** The sites of the layout that exist and the user may access. */
async function accessibleSites(userId: string, layout: DashboardLayout): Promise<Set<string>> {
  const chosen = layout.charts
    .map((c) => c.siteId)
    .filter((id): id is string => typeof id === 'string');
  if (chosen.length === 0) return new Set();
  const scope = await getUserSiteIds(userId);
  const inScope = chosen.filter((id) => siteInScope(scope, id));
  return existingDashboardSiteIds(inScope);
}

/**
 * The layout as the user may see it: a site that was deleted or left the
 * user's site scope becomes null and is marked `siteUnavailable`, so the
 * widget shows the default site and says why. The stored layout keeps it
 * until the next save.
 */
async function scopedLayout(
  userId: string,
  layout: DashboardLayout,
): Promise<{ version: 1; charts: LayoutReplyItem[] }> {
  const allowed = await accessibleSites(userId, layout);
  return {
    version: 1,
    charts: layout.charts.map((c) =>
      typeof c.siteId === 'string' && !allowed.has(c.siteId)
        ? { ...c, siteId: null, siteUnavailable: true as const }
        : c,
    ),
  };
}

export function userDashboardLayoutRoutes(app: FastifyInstance): void {
  app.get(
    '/users/me/dashboard-layout',
    {
      onRequest: [selfService()],
      schema: {
        tags: ['Users'],
        summary: 'Get the dashboard layout of the current user',
        operationId: 'getUserDashboardLayout',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(layoutResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const stored = await getUserDashboardLayout(userId);
      return {
        layout: await scopedLayout(userId, resolveDashboardLayout(stored)),
        customized: stored != null,
      };
    },
  );

  app.put(
    '/users/me/dashboard-layout',
    {
      onRequest: [selfService()],
      schema: {
        tags: ['Users'],
        summary: 'Save the dashboard layout of the current user',
        description:
          'Replaces the stored layout of the charts. Unknown chart ids, repeated ids and a siteId the user may not access (or on a chart that takes none) are refused. The stat cards are not part of the layout.',
        operationId: 'updateUserDashboardLayout',
        security: [{ bearerAuth: [] }],
        body: zodSchema(layoutBody),
        response: {
          200: itemResponse(layoutResponse),
          400: errorWith('Invalid layout', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
    },
    async (request, res) => {
      const { userId } = request.user as JwtPayload;
      const problem = dashboardLayoutProblem(request.body);
      if (problem != null) {
        return res.status(400).send({ error: problem, code: ERROR_CODES.VALIDATION_ERROR });
      }
      const layout = resolveDashboardLayout(request.body);
      const allowed = await accessibleSites(userId, layout);
      // A site outside the user's scope answers like a missing one.
      if (layout.charts.some((c) => typeof c.siteId === 'string' && !allowed.has(c.siteId))) {
        return res.status(400).send({
          error: 'siteId is not a site you can access',
          code: ERROR_CODES.VALIDATION_ERROR,
        });
      }
      await saveUserDashboardLayout(userId, layout);
      return { layout, customized: true };
    },
  );

  app.delete(
    '/users/me/dashboard-layout',
    {
      onRequest: [selfService()],
      schema: {
        tags: ['Users'],
        summary: 'Reset the dashboard layout of the current user',
        operationId: 'resetUserDashboardLayout',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(layoutResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      await deleteUserDashboardLayout(userId);
      return { layout: defaultDashboardLayout(), customized: false };
    },
  );
}
