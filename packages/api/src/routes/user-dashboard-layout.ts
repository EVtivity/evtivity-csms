// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Live dashboard layout of the signed-in user: chart order and
// visibility (the stat cards are fixed). A browser preference of the user, so signed-in
// sessions only (no API keys) and no audit row. Every write goes through the
// one writer in `@evtivity/database` (`lib/dashboard-layout.ts`).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteUserDashboardLayout,
  getUserDashboardLayout,
  saveUserDashboardLayout,
} from '@evtivity/database';
import {
  DASHBOARD_LAYOUT_MAX_ITEMS,
  DASHBOARD_WIDGET_ID_MAX_LENGTH,
  dashboardLayoutProblem,
  defaultDashboardLayout,
  resolveDashboardLayout,
  type DashboardLayout,
} from '@evtivity/lib/dashboard-layout';
import type { JwtPayload } from '../plugins/auth.js';
import { selfService } from '../middleware/rbac.js';
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
  })
  .loose();

const layoutBody = z.object({
  version: z.literal(1).describe('Layout format version'),
  charts: z
    .array(
      z.object({
        id: z.string().max(DASHBOARD_WIDGET_ID_MAX_LENGTH).describe('Chart widget id'),
        hidden: z.boolean().describe('True to hide the chart'),
      }),
    )
    .max(DASHBOARD_LAYOUT_MAX_ITEMS)
    .describe('Charts in display order. Charts left out are appended in the default order'),
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

function reply(stored: unknown): { layout: DashboardLayout; customized: boolean } {
  return { layout: resolveDashboardLayout(stored), customized: stored != null };
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
      return reply(await getUserDashboardLayout(userId));
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
          'Replaces the stored layout of the charts. Unknown chart ids and repeated ids are refused. The stat cards are not part of the layout.',
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
