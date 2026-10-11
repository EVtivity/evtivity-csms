// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI usage routes (plan v0.1.44, item 5): usage and budgets from the usage
 * ledger. Company totals, the usage that belongs to no site and the per-user
 * rows are for users with access to every site; site rows follow the user's
 * site scope.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, inArray } from 'drizzle-orm';
import {
  aiUsageBySiteAndSurface,
  aiUsageMonth,
  aiUsageMonthOf,
  aiUsageOfUser,
  aiUsageTopUsers,
  aiUsageUtcDay,
  db,
  getAiSettings,
  getSystemTimezone,
  sites,
} from '@evtivity/database';
import type { AiUsageMonth, AiUsageSums } from '@evtivity/database';
import {
  AI_USAGE_SURFACES,
  aiMyUsageDtoSchema,
  aiSiteUsageDtoSchema,
  aiUsageDtoSchema,
} from '@evtivity/lib/ai-usage';
import type {
  AiMyUsageDto,
  AiSiteUsageDto,
  AiUsageBudget,
  AiUsageDto,
  AiUsageSiteRow,
  AiUsageSurface,
  AiUsageTotals,
} from '@evtivity/lib/ai-usage';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { AI_ASSISTANT_READ_PERMISSION } from '../services/ai/engine/route-support.js';
import type { JwtPayload } from '../plugins/auth.js';

/** The permission that shows company and site AI usage. */
export const AI_USAGE_PERMISSION = 'aiUsage:read';

/** Rows in the top users table. */
const TOP_USERS = 10;

const monthQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .describe('Calendar month, YYYY-MM, in the system timezone. Defaults to the current month'),
});

const siteParams = z.object({
  siteId: z.string().describe('Site identifier'),
});

const EMPTY: AiUsageSums = {
  input: 0,
  cachedRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  costMicros: 0,
};

function add(a: AiUsageSums, b: AiUsageSums): AiUsageSums {
  return {
    input: a.input + b.input,
    cachedRead: a.cachedRead + b.cachedRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    costMicros: a.costMicros + b.costMicros,
  };
}

function budgetTokens(sums: AiUsageSums): number {
  return sums.input + sums.output;
}

function totals(sums: AiUsageSums): AiUsageTotals {
  return {
    tokens: {
      input: sums.input,
      cachedRead: sums.cachedRead,
      cacheWrite: sums.cacheWrite,
      output: sums.output,
      reasoning: sums.reasoning,
    },
    totalTokens: budgetTokens(sums),
    costMicros: sums.costMicros,
  };
}

/** A budget view; a limit of 0 means no limit. */
function budget(limit: number, used: number): AiUsageBudget {
  if (limit <= 0) return { limitTokens: null, usedTokens: used, percent: null };
  return {
    limitTokens: limit,
    usedTokens: used,
    percent: Math.round((used * 1000) / limit) / 10,
  };
}

async function monthOf(month: string | undefined): Promise<AiUsageMonth> {
  const timeZone = await getSystemTimezone();
  return aiUsageMonth(month ?? aiUsageMonthOf(new Date(), timeZone), timeZone);
}

function periodView(month: AiUsageMonth): { start: string; end: string } {
  return { start: month.start.toISOString(), end: month.end.toISOString() };
}

function surfaceRows(
  rows: readonly { surface: AiUsageSurface; sums: AiUsageSums }[],
): AiUsageDto['surfaces'] {
  const bySurface = new Map<AiUsageSurface, AiUsageSums>();
  for (const row of rows) {
    bySurface.set(row.surface, add(bySurface.get(row.surface) ?? EMPTY, row.sums));
  }
  return AI_USAGE_SURFACES.filter((s) => bySurface.has(s)).map((surface) => ({
    surface,
    totals: totals(bySurface.get(surface) ?? EMPTY),
  }));
}

async function sitesInScope(
  siteIds: string[] | null,
): Promise<{ id: string; name: string; aiMonthlyTokenBudget: number | null }[]> {
  if (siteIds !== null && siteIds.length === 0) return [];
  const query = db
    .select({ id: sites.id, name: sites.name, aiMonthlyTokenBudget: sites.aiMonthlyTokenBudget })
    .from(sites)
    .orderBy(asc(sites.name));
  return siteIds === null ? query : query.where(inArray(sites.id, siteIds));
}

function siteRow(
  site: { id: string; name: string; aiMonthlyTokenBudget: number | null },
  sums: AiUsageSums,
  defaultSiteMonthly: number,
): AiUsageSiteRow {
  return {
    siteId: site.id,
    siteName: site.name,
    totals: totals(sums),
    budget: budget(site.aiMonthlyTokenBudget ?? defaultSiteMonthly, budgetTokens(sums)),
  };
}

export function aiUsageRoutes(app: FastifyInstance): void {
  app.get(
    '/ai/usage',
    {
      onRequest: [authorize(AI_USAGE_PERMISSION)],
      schema: {
        tags: ['AI'],
        summary: 'AI usage and budgets of a month',
        description:
          'Token usage and budgets from the usage ledger. Company totals, usage that belongs to no site and the top users are null for a user restricted to some sites.',
        operationId: 'getAiUsage',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(monthQuery),
        response: {
          200: itemResponse(aiUsageDtoSchema.describe('AI usage of the month')),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const query = parseZodRequest(monthQuery, request.query);
      const [month, siteIds, settings] = await Promise.all([
        monthOf(query.month),
        getUserSiteIds(userId),
        getAiSettings(),
      ]);
      const allSites = siteIds === null;
      const [rows, siteList, topUsers] = await Promise.all([
        aiUsageBySiteAndSurface(month),
        sitesInScope(siteIds),
        allSites ? aiUsageTopUsers(month, TOP_USERS) : Promise.resolve(null),
      ]);
      const scope = new Set(siteList.map((s) => s.id));
      const scopedRows = allSites
        ? rows
        : rows.filter((r) => r.siteId !== null && scope.has(r.siteId));
      const bySite = new Map<string, AiUsageSums>();
      let unattributed = EMPTY;
      let company = EMPTY;
      for (const row of rows) {
        company = add(company, row.sums);
        if (row.siteId === null || !scope.has(row.siteId)) {
          // A deleted site's rows lost their site id (ON DELETE SET NULL).
          if (row.siteId === null) unattributed = add(unattributed, row.sums);
          continue;
        }
        bySite.set(row.siteId, add(bySite.get(row.siteId) ?? EMPTY, row.sums));
      }
      const dto: AiUsageDto = {
        month: month.month,
        period: periodView(month),
        company: allSites
          ? {
              totals: totals(company),
              budget: budget(settings.limits.companyMonthlyTokens, budgetTokens(company)),
            }
          : null,
        unattributed: allSites ? totals(unattributed) : null,
        sites: siteList.map((site) =>
          siteRow(site, bySite.get(site.id) ?? EMPTY, settings.limits.siteMonthlyTokens),
        ),
        surfaces: surfaceRows(scopedRows),
        topUsers:
          topUsers === null
            ? null
            : topUsers.map((u) => ({ userId: u.userId, totals: totals(u.sums) })),
      };
      return dto;
    },
  );

  app.get(
    '/ai/usage/sites/:siteId',
    {
      onRequest: [authorize(AI_USAGE_PERMISSION)],
      schema: {
        tags: ['AI'],
        summary: "A site's AI usage and monthly budget",
        operationId: 'getAiSiteUsage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(monthQuery),
        response: {
          200: itemResponse(aiSiteUsageDtoSchema.describe("A site's AI usage of the month")),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { siteId } = parseZodRequest(siteParams, request.params);
      const query = parseZodRequest(monthQuery, request.query);
      const siteIds = await getUserSiteIds(userId);
      const [site] = siteInScope(siteIds, siteId) ? await sitesInScope([siteId]) : [];
      if (site === undefined) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [month, settings] = await Promise.all([monthOf(query.month), getAiSettings()]);
      const rows = await aiUsageBySiteAndSurface(month, siteId);
      const sums = rows.reduce((acc, r) => add(acc, r.sums), EMPTY);
      const dto: AiSiteUsageDto = {
        month: month.month,
        period: periodView(month),
        site: siteRow(site, sums, settings.limits.siteMonthlyTokens),
        surfaces: surfaceRows(rows),
      };
      return dto;
    },
  );

  app.get(
    '/users/me/ai-usage',
    {
      onRequest: [authorize(AI_ASSISTANT_READ_PERMISSION)],
      schema: {
        tags: ['AI'],
        summary: 'My AI usage',
        description:
          "The caller's own AI usage: today (UTC) against the daily budget, and this calendar month.",
        operationId: 'getMyAiUsage',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(aiMyUsageDtoSchema.describe('My AI usage')),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const now = new Date();
      const [month, settings] = await Promise.all([monthOf(undefined), getAiSettings()]);
      const [today, thisMonth] = await Promise.all([
        aiUsageOfUser(userId, aiUsageUtcDay(now)),
        aiUsageOfUser(userId, month),
      ]);
      const dto: AiMyUsageDto = {
        today: budget(settings.limits.userDailyTokens, budgetTokens(today)),
        month: totals(thisMonth),
      };
      return dto;
    },
  );
}
