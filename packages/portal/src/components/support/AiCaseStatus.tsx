// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { isAiAnalyzing } from './driver-ai';
import type { PortalCaseAi } from './driver-ai';

interface AiCaseStatusProps {
  caseId: string;
  ai: PortalCaseAi;
}

/**
 * The AI step of a case, under the messages: the analysis status (an
 * `aria-live` region), the one feedback question, or the end state. The
 * answer itself is the assistant message in the thread. No error code,
 * provider or model name is shown.
 */
export function AiCaseStatus({ caseId, ai }: AiCaseStatusProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const feedback = useMutation({
    mutationFn: (satisfied: boolean) =>
      api.post(`/v1/portal/support-cases/${caseId}/ai-feedback`, { satisfied }),
    // Settled: a 409 means the case already moved on, so reload it either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-support-case', caseId] });
      void queryClient.invalidateQueries({ queryKey: ['portal-support-cases'] });
    },
  });

  if (ai.consent !== 'granted' || ai.state == null) return null;

  const analyzing = isAiAnalyzing(ai);
  const awaiting = ai.state === 'awaiting_feedback';

  // One persistent live region, so the change from analyzing to the answer
  // or the end state is announced (plan 2.11, accessibility).
  let statusText: React.ReactNode = null;
  if (analyzing) {
    statusText = (
      <>
        <Spinner className="h-5 w-5" />
        <span>{t('supportCases.ai.analyzing')}</span>
      </>
    );
  } else if (ai.state === 'resolved_by_ai') {
    statusText = (
      <>
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        <span>{t('supportCases.ai.resolved')}</span>
      </>
    );
  } else if (!awaiting) {
    // escalated, failed, skipped: the case is with the support team.
    statusText = (
      <>
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>
          {t(ai.state === 'escalated' ? 'supportCases.ai.escalated' : 'supportCases.ai.sentToTeam')}
        </span>
      </>
    );
  }

  return (
    <div
      data-testid="ai-case-status"
      data-ai-state={ai.state}
      className="mb-3 space-y-2 rounded-lg border bg-card p-3"
    >
      <div
        role="status"
        aria-live="polite"
        className={statusText == null ? 'sr-only' : 'flex items-center gap-2 text-sm'}
      >
        {statusText}
      </div>
      {awaiting && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('supportCases.ai.feedbackQuestion')}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={feedback.isPending}
              onClick={() => {
                feedback.mutate(true);
              }}
            >
              {t('supportCases.ai.feedbackYes')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={feedback.isPending}
              onClick={() => {
                feedback.mutate(false);
              }}
            >
              {t('supportCases.ai.feedbackNo')}
            </Button>
          </div>
          {/* Only when the answer said a person is needed (plan 2.6). */}
          {ai.needsOperator === true && (
            <p className="text-xs text-muted-foreground">{t('supportCases.ai.feedbackNoHint')}</p>
          )}
          {feedback.isError && (
            <p className="text-sm text-destructive">{t('supportCases.ai.feedbackFailed')}</p>
          )}
        </div>
      )}
    </div>
  );
}
