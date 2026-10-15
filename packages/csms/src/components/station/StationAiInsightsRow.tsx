// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';

export interface StationAiInsightsState {
  aiInsightsSuppressed?: boolean;
  aiInsightsSuppressedByMaintenance?: boolean;
  aiInsightsSuppressedAt?: string | null;
  aiInsightsSuppressedUntil?: string | null;
  aiInsightsSuppressedByName?: string | null;
  aiInsightsSuppressedReason?: string | null;
}

/**
 * The AI Insights row of the station Details card: In Scope, or Suppressed
 * (until a date, by whom, why), with Suppress and Resume for a user with
 * stations:write. An active maintenance event also suppresses the insights.
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
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);

  const operatorSuppressed = station.aiInsightsSuppressedAt != null;
  const suppressed = station.aiInsightsSuppressed === true;

  const done = (title: string): void => {
    toast({ variant: 'success', title });
    void queryClient.invalidateQueries({ queryKey: ['stations', stationId] });
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
  };
  const failed = (err: unknown): void => {
    toast({
      variant: 'destructive',
      title: getErrorMessage(err, t, 'stations.aiInsights.failed'),
    });
  };

  const suppressMutation = useMutation({
    mutationFn: () =>
      api.post(`/v1/stations/${stationId}/ai-insights/suppress`, {
        reason: reason.trim(),
        ...(until !== '' ? { until: new Date(until).toISOString() } : {}),
      }),
    onSuccess: () => {
      setSuppressOpen(false);
      setReason('');
      setUntil('');
      done(t('stations.aiInsights.suppressedToast'));
    },
    onError: failed,
  });
  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationId}/ai-insights/resume`, {}),
    onSuccess: () => {
      done(t('stations.aiInsights.resumedToast'));
    },
    onError: failed,
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
                setReasonMissing(false);
                setSuppressOpen(true);
              }}
            >
              {t('stations.aiInsights.suppress')}
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
              {t('stations.aiInsights.resume')}
            </Button>
          )}
        </div>
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

      <ConfirmDialog
        open={suppressOpen}
        onOpenChange={setSuppressOpen}
        title={t('stations.aiInsights.suppressTitle')}
        description={t('stations.aiInsights.suppressDescription')}
        confirmLabel={t('stations.aiInsights.suppress')}
        variant="default"
        isPending={suppressMutation.isPending}
        onConfirm={() => {
          if (reason.trim() === '') {
            setReasonMissing(true);
            return false;
          }
          suppressMutation.mutate();
          return false;
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="ai-suppress-reason">{t('stations.aiInsights.reason')}</Label>
          <Textarea
            id="ai-suppress-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonMissing(false);
            }}
          />
          {reasonMissing && (
            <p className="text-sm text-destructive">{t('stations.aiInsights.reasonRequired')}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-suppress-until">{t('stations.aiInsights.endDate')}</Label>
          <Input
            id="ai-suppress-until"
            type="datetime-local"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
            }}
          />
        </div>
      </ConfirmDialog>

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
