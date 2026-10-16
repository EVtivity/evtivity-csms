// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
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

export interface StationAiInsightsState {
  siteId?: string | null;
  siteName?: string | null;
  aiInsightsSuppressed?: boolean;
  aiInsightsSuppressedByMaintenance?: boolean;
  /** What suppresses the insights now: station, site, maintenance. */
  aiInsightsSuppressedSources?: string[];
  aiInsightsSuppressedAt?: string | null;
  aiInsightsSuppressedUntil?: string | null;
  aiInsightsSuppressedByName?: string | null;
  aiInsightsSuppressedReason?: string | null;
}

/**
 * The AI Insights row of the station Details card: In Scope, or Suppressed
 * (until a date, by whom, why), with Suppress and Resume for a user with
 * stations:write. A suppression of the station's site ("Suppressed with its
 * site", linking the site) and an active maintenance event also suppress the
 * insights. While the site is suppressed the station cannot be resumed (the
 * API answers 409 STATION_SITE_SUPPRESSED), so Resume is hidden; its own
 * Suppress still works and is kept for when the site resumes.
 */
export function StationAiInsightsRow({
  stationId,
  station,
  timezone,
}: {
  stationId: string;
  station: StationAiInsightsState;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');
  const [suppressOpen, setSuppressOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);

  const operatorSuppressed = station.aiInsightsSuppressedAt != null;
  const suppressed = station.aiInsightsSuppressed === true;
  const withSite = station.aiInsightsSuppressedSources?.includes('site') === true;

  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationId}/ai-insights/resume`, {}),
    onSuccess: () => {
      toast({ variant: 'success', title: t('stations.aiInsights.resumedToast') });
      invalidateAiInsightsSuppression(queryClient, 'station', stationId);
    },
    onError: (err: unknown) => {
      toast({
        variant: 'destructive',
        title: getErrorMessage(err, t, 'stations.aiInsights.failed'),
      });
    },
    onSettled: () => {
      setResumeOpen(false);
    },
  });

  return (
    <div data-testid="station-ai-insights">
      <dt className="text-muted-foreground">{t('stations.aiInsights.label')}</dt>
      <dd className="space-y-1 font-medium">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={suppressed ? 'warning' : 'success'}
            data-testid="station-ai-insights-badge"
          >
            {suppressed ? t('stations.aiInsights.suppressed') : t('stations.aiInsights.inScope')}
          </Badge>
          {canWrite && !operatorSuppressed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSuppressOpen(true);
              }}
            >
              {t('stations.aiInsights.suppress')}
            </Button>
          )}
          {canWrite && operatorSuppressed && !withSite && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setResumeOpen(true);
              }}
            >
              {t('stations.aiInsights.resume')}
            </Button>
          )}
        </div>
        {withSite && (
          <p
            className="text-sm font-normal text-muted-foreground"
            data-testid="station-ai-insights-with-site"
          >
            {t('stations.aiInsights.withSite')}
            {station.siteId != null && (
              <>
                {' · '}
                <Link
                  to={`/sites/${encodeURIComponent(station.siteId)}`}
                  className="text-link hover:underline"
                >
                  {station.siteName ?? station.siteId}
                </Link>
              </>
            )}
          </p>
        )}
        {operatorSuppressed && (
          <p
            className="text-sm font-normal text-muted-foreground"
            data-testid="station-ai-insights-detail"
          >
            {station.aiInsightsSuppressedUntil != null
              ? t('stations.aiInsights.until', {
                  date: formatDateTime(station.aiInsightsSuppressedUntil, timezone),
                })
              : t('stations.aiInsights.untilResumed')}
            {' · '}
            {t('stations.aiInsights.by', {
              name: station.aiInsightsSuppressedByName ?? t('common.na'),
              reason: station.aiInsightsSuppressedReason ?? '',
            })}
          </p>
        )}
        {station.aiInsightsSuppressedByMaintenance === true && (
          <p className="text-sm font-normal text-muted-foreground">
            {t('stations.aiInsights.maintenance')}
          </p>
        )}
      </dd>

      <AiInsightsSuppressDialog
        target="station"
        id={stationId}
        open={suppressOpen}
        onOpenChange={setSuppressOpen}
      />

      <ConfirmDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title={t('stations.aiInsights.resumeTitle')}
        description={t('stations.aiInsights.resumeDescription')}
        confirmLabel={t('stations.aiInsights.resume')}
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
