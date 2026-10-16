// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AiInsightsSuppressDialog,
  invalidateAiInsightsSuppression,
} from '@/components/ai/insights/AiInsightsSuppressDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';

export interface SiteAiInsightsState {
  aiInsightsSuppressed?: boolean;
  /** What suppresses the insights now: site, maintenance. */
  aiInsightsSuppressedSources?: string[];
  aiInsightsSuppressedAt?: string | null;
  aiInsightsSuppressedUntil?: string | null;
  aiInsightsSuppressedByName?: string | null;
  aiInsightsSuppressedReason?: string | null;
}

/**
 * The AI Insights row of the site Details card: In Scope, or Suppressed
 * (until a date, by whom, why), with Suppress and Resume for a user with
 * sites:write. A suppressed site suppresses every one of its stations; an
 * active maintenance event of the whole site also suppresses the insights.
 */
export function SiteAiInsightsRow({
  siteId,
  site,
  timezone,
}: {
  siteId: string;
  site: SiteAiInsightsState;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');
  const [suppressOpen, setSuppressOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);

  const operatorSuppressed = site.aiInsightsSuppressedAt != null;
  const suppressed = site.aiInsightsSuppressed === true;
  const byMaintenance = site.aiInsightsSuppressedSources?.includes('maintenance') === true;

  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/v1/sites/${encodeURIComponent(siteId)}/ai-insights/resume`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('sites.aiInsights.resumedToast') });
      invalidateAiInsightsSuppression(queryClient, 'site', siteId);
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t, 'sites.aiInsights.failed') });
    },
    onSettled: () => {
      setResumeOpen(false);
    },
  });

  return (
    <div data-testid="site-ai-insights">
      <dt className="text-muted-foreground">{t('sites.aiInsights.label')}</dt>
      <dd className="space-y-1 font-medium">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={suppressed ? 'warning' : 'success'} data-testid="site-ai-insights-badge">
            {suppressed ? t('sites.aiInsights.suppressed') : t('sites.aiInsights.inScope')}
          </Badge>
          {canWrite && !operatorSuppressed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSuppressOpen(true);
              }}
            >
              {t('sites.aiInsights.suppress')}
            </Button>
          )}
          {canWrite && operatorSuppressed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setResumeOpen(true);
              }}
            >
              {t('sites.aiInsights.resume')}
            </Button>
          )}
        </div>
        {operatorSuppressed && (
          <p
            className="text-sm font-normal text-muted-foreground"
            data-testid="site-ai-insights-detail"
          >
            {site.aiInsightsSuppressedUntil != null
              ? t('sites.aiInsights.until', {
                  date: formatDateTime(site.aiInsightsSuppressedUntil, timezone),
                })
              : t('sites.aiInsights.untilResumed')}
            {' · '}
            {t('sites.aiInsights.by', {
              name: site.aiInsightsSuppressedByName ?? t('common.na'),
              reason: site.aiInsightsSuppressedReason ?? '',
            })}
          </p>
        )}
        {byMaintenance && (
          <p className="text-sm font-normal text-muted-foreground">
            {t('sites.aiInsights.maintenance')}
          </p>
        )}
      </dd>

      <AiInsightsSuppressDialog
        target="site"
        id={siteId}
        open={suppressOpen}
        onOpenChange={setSuppressOpen}
      />

      <ConfirmDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title={t('sites.aiInsights.resumeTitle')}
        description={t('sites.aiInsights.resumeDescription')}
        confirmLabel={t('sites.aiInsights.resume')}
        variant="default"
        isPending={resumeMutation.isPending}
        onConfirm={() => {
          resumeMutation.mutate();
          return false;
        }}
      />
    </div>
  );
}
