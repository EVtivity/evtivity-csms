// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `GET /v1/ai/alerts`: what the CSMS AI alert banner and Settings > AI show.
 * The providers whose account answered out of credit or quota (background AI
 * features are paused for them) and the company monthly budget once it is
 * at or past `ai.budget.warnPercent`. Company-wide, so for users with access
 * to every site, like the other AI settings. The SSE event
 * `ai.alerts.changed` (and `ai.usage.threshold`) tells the CSMS to refetch.
 */

import type { FastifyInstance } from 'fastify';
import { getActiveAiProviderAlerts, getCompanyAiBudgetStatus } from '@evtivity/database';
import { aiAlertsDtoSchema } from '@evtivity/lib/ai-usage';
import type { AiAlertsDto } from '@evtivity/lib/ai-usage';
import { authorize } from '../middleware/rbac.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';

const settingNotFound = { error: 'Setting not found', code: 'SETTING_NOT_FOUND' } as const;

export async function readAiAlerts(): Promise<AiAlertsDto> {
  const [providers, budget] = await Promise.all([
    getActiveAiProviderAlerts(),
    getCompanyAiBudgetStatus(),
  ]);
  return {
    providers: providers.map((a) => ({
      provider: a.provider,
      since: a.since.toISOString(),
      lastSeenAt: a.lastSeenAt.toISOString(),
    })),
    companyBudget:
      budget?.level != null
        ? {
            period: budget.period,
            level: budget.level,
            percent: budget.percent,
            usedTokens: budget.usedTokens,
            limitTokens: budget.limitTokens,
          }
        : null,
  };
}

export function aiAlertsRoutes(app: FastifyInstance): void {
  app.get(
    '/ai/alerts',
    {
      onRequest: [authorize('settings.ai:read')],
      schema: {
        tags: ['AI'],
        summary: 'Active AI alerts',
        description:
          'AI providers whose account is out of credit or quota (background AI features are paused for them until a call succeeds again) and the company monthly token budget when it is at or past its warning level. For users with access to every site.',
        operationId: 'getAiAlerts',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(aiAlertsDtoSchema.describe('Active AI alerts')),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      return readAiAlerts();
    },
  );
}
