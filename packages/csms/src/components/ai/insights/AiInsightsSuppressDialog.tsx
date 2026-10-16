// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { AI_INSIGHTS_KEY } from './insight-api';

export type AiInsightsSuppressTarget = 'station' | 'site';

const KEYS = {
  station: 'stations.aiInsights',
  site: 'sites.aiInsights',
} as const satisfies Record<AiInsightsSuppressTarget, string>;

/** Query keys a suppression or a resume of the target changes. */
export function invalidateAiInsightsSuppression(
  queryClient: ReturnType<typeof useQueryClient>,
  target: AiInsightsSuppressTarget,
  id: string,
): void {
  // A site suppression changes the state of every station of the site too.
  void queryClient.invalidateQueries({ queryKey: ['stations'] });
  if (target === 'site') void queryClient.invalidateQueries({ queryKey: ['sites'] });
  else void queryClient.invalidateQueries({ queryKey: ['stations', id] });
  // Suppressing dismisses open insights and expires their waiting actions.
  void queryClient.invalidateQueries({ queryKey: AI_INSIGHTS_KEY });
}

/**
 * The one Suppress dialog of the AI insights of a station or a site (reason,
 * optional end date): the station and site Details rows and the insight
 * detail shortcuts open it. Posts to `/v1/{stations|sites}/:id/ai-insights/suppress`,
 * shows a toast and refreshes the station, site and insight queries.
 */
export function AiInsightsSuppressDialog({
  target,
  id,
  open,
  onOpenChange,
}: {
  target: AiInsightsSuppressTarget;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const keys = KEYS[target];
  const path = target === 'site' ? 'sites' : 'stations';

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/v1/${path}/${encodeURIComponent(id)}/ai-insights/suppress`, {
        reason: reason.trim(),
        ...(until !== '' ? { until: new Date(until).toISOString() } : {}),
      }),
    onSuccess: () => {
      onOpenChange(false);
      setReason('');
      setUntil('');
      toast({ variant: 'success', title: t(`${keys}.suppressedToast`) });
      invalidateAiInsightsSuppression(queryClient, target, id);
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t, `${keys}.failed`) });
    },
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReasonMissing(false);
        onOpenChange(next);
      }}
      title={t(`${keys}.suppressTitle`)}
      description={t(`${keys}.suppressDescription`)}
      confirmLabel={t(`${keys}.suppress`)}
      variant="default"
      isPending={mutation.isPending}
      onConfirm={() => {
        if (reason.trim() === '') {
          setReasonMissing(true);
          return false;
        }
        mutation.mutate();
        return false;
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`ai-suppress-reason-${target}`}>{t('stations.aiInsights.reason')}</Label>
        <Textarea
          id={`ai-suppress-reason-${target}`}
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
        <Label htmlFor={`ai-suppress-until-${target}`}>{t('stations.aiInsights.endDate')}</Label>
        <Input
          id={`ai-suppress-until-${target}`}
          type="datetime-local"
          value={until}
          onChange={(e) => {
            setUntil(e.target.value);
          }}
        />
      </div>
    </ConfirmDialog>
  );
}
