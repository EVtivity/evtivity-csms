// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Ban, Check } from 'lucide-react';
import { isAiProposalRefusalReason } from '@evtivity/lib/ai-proposals';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmButton } from '@/components/confirm-button';
import { RejectButton } from '@/components/reject-button';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { httpMethodVariant } from '@/lib/status-variants';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { useToast } from '@/components/ui/toast';
import { useHasPermission } from '@/lib/auth';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { aiRequestErrorText } from '../ai-error-text';
import type { AiInsightActionView, AiInsightView } from './insight-api';
import { useDecideInsightAction } from './insight-api';
import {
  actionLabel,
  actionRan,
  actionSentence,
  actionTransactionId,
  isActionOpen,
  readActionSummary,
} from './insight-action';

/**
 * Reject and Confirm of an insight's action, right-aligned, each behind the
 * standard ConfirmDialog. Confirm sends the `argsHash` the user saw, so an
 * action that changed since cannot run. Hidden without `aiInsights:write`
 * and once the action is decided or expired. A refusal (stale, expired,
 * already decided) shows inline; a decision that went through raises a
 * toast that closes on its own.
 */
export function InsightActionDecision({
  insightId,
  insightStatus,
  action,
  sentence,
}: {
  insightId: string;
  /** The insight's one status: only `pending` takes a decision. */
  insightStatus: string;
  action: AiInsightActionView;
  sentence: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canWrite = useHasPermission('aiInsights:write');
  const decide = useDecideInsightAction();
  const [dialog, setDialog] = useState<'confirm' | 'reject' | null>(null);
  if (!canWrite) return null;
  const open = isActionOpen(insightStatus, action);

  function run(verb: 'confirm' | 'reject'): void {
    const decision =
      verb === 'confirm' ? { verb, insightId, argsHash: action.argsHash } : { verb, insightId };
    decide.mutate(decision, {
      onSuccess: (result) => {
        setDialog(null);
        if (verb === 'reject') {
          toast({ variant: 'success', title: t('aiInsights.action.rejectedToast') });
        } else if (result.status === 'done') {
          toast({ variant: 'success', title: t('aiInsights.action.executed') });
        } else {
          toast({ variant: 'destructive', title: t('aiInsights.action.confirmFailed') });
        }
      },
      onError: () => {
        setDialog(null);
      },
    });
  }

  return (
    <div className="space-y-2">
      {/* Always shown; disabled once the action is decided or past its deadline. */}
      <div className="flex flex-wrap justify-end gap-2" data-testid="ai-action-buttons">
        <RejectButton
          label={t('aiInsights.action.reject')}
          size="sm"
          disabled={!open || decide.isPending}
          testId="ai-action-reject"
          onClick={() => {
            decide.reset();
            setDialog('reject');
          }}
        />
        <ConfirmButton
          label={t('aiInsights.action.confirm')}
          size="sm"
          disabled={!open || decide.isPending}
          testId="ai-action-confirm"
          onClick={() => {
            decide.reset();
            setDialog('confirm');
          }}
        />
      </div>
      {decide.error != null && (
        <Alert variant="destructive" role="alert" data-testid="ai-action-error">
          <AlertCircle />
          <AlertDescription>{aiRequestErrorText(decide.error, t)}</AlertDescription>
        </Alert>
      )}
      <ConfirmDialog
        open={dialog === 'confirm'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={t('aiInsights.action.confirmDialog.title')}
        description={sentence}
        confirmLabel={t('aiInsights.action.confirm')}
        confirmIcon={<Check className="h-4 w-4" />}
        variant="default"
        isPending={decide.isPending}
        onConfirm={() => {
          run('confirm');
          return false;
        }}
      >
        <p className="text-sm text-muted-foreground">{t('aiInsights.action.confirmDialog.note')}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'reject'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={t('aiInsights.action.rejectDialog.title')}
        description={sentence}
        confirmLabel={t('aiInsights.action.reject')}
        confirmIcon={<Ban className="h-4 w-4" />}
        isPending={decide.isPending}
        onConfirm={() => {
          run('reject');
          return false;
        }}
      />
    </div>
  );
}

/**
 * The action an insight carries (a background worker suggestion), inside the
 * insight card: what runs (the localized sentence), its expiry (the insight's
 * one status badge covers the action),
 * the rationale and the measured values, the OCPP transaction id as plain
 * text, the result, and
 * Reject and Confirm. The sentence already names the station and the
 * command, so the raw arguments are not listed again.
 * Nothing runs until an operator confirms it, with their own permissions.
 */
export function InsightActionSection({
  insight,
}: {
  insight: AiInsightView;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const action = insight.action;
  if (action == null) return null;
  const ran = actionRan(action);
  const sentence = actionSentence(t, action);
  const { rationale, measured } = readActionSummary(action.summary);
  const minutes = rationale?.params['minutes'];
  const transactionId = actionTransactionId(action);
  // An action refused at confirm stores only the reason code (no English text).
  const refused = (action.result?.body as { refused?: unknown } | null | undefined)?.refused;
  const refusal = isAiProposalRefusalReason(refused) ? refused : null;

  return (
    <div aria-label={actionLabel(t, action)} data-testid="ai-insight-action" className="space-y-3">
      <div className="space-y-1">
        <p className="wrap-anywhere font-medium" data-testid="ai-insight-action-summary">
          {sentence}
        </p>
      </div>

      <DescriptionList>
        {rationale != null && (
          <DescriptionItem label={t('aiInsights.action.rationale')}>
            <span data-testid="ai-insight-action-rationale">
              {t(`aiWorkers.rationale.${rationale.code}`, rationale.params)}
            </span>
          </DescriptionItem>
        )}
        {minutes != null && (
          <DescriptionItem label={t('aiInsights.action.measured.idleTime')}>
            {t('aiInsights.action.measured.minutes', { count: Number(minutes) })}
          </DescriptionItem>
        )}
        {measured.lastActivityAt != null && (
          <DescriptionItem label={t('aiInsights.action.measured.lastActivity')}>
            {formatDateTime(measured.lastActivityAt, timezone)}
          </DescriptionItem>
        )}
        {measured.faultedSince != null && (
          <DescriptionItem label={t('aiInsights.action.measured.faultedSince')}>
            {formatDateTime(measured.faultedSince, timezone)}
          </DescriptionItem>
        )}
        {transactionId != null && (
          <DescriptionItem label={t('aiInsights.action.measured.transactionId')}>
            <span
              className="block min-w-0 truncate"
              title={transactionId}
              data-testid="ai-insight-action-transaction"
            >
              {transactionId}
            </span>
          </DescriptionItem>
        )}
      </DescriptionList>

      {action.result != null && (
        <Alert variant={ran ? 'success' : 'destructive'}>
          <AlertDescription>
            {ran ? t('aiInsights.action.executed') : t('aiInsights.action.confirmFailed')}
            {action.result.httpStatus > 0 && ` (HTTP ${String(action.result.httpStatus)})`}
            {refusal !== null && (
              <span className="block" data-testid="ai-insight-action-refusal">
                {t(`aiInsights.action.refused.${refusal}`)}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* The exact API call, closed by default, for operators who want the details. */}
      <Collapsible
        title={t('aiInsights.action.apiRequest')}
        summary={
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
            <Badge
              variant={httpMethodVariant(action.method)}
              data-testid="ai-insight-action-method"
            >
              {action.method}
            </Badge>
            <span className="min-w-0 wrap-anywhere font-mono text-xs">{action.path}</span>
          </span>
        }
        data-testid="ai-insight-action-api"
      >
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(action.args, null, 2)}
        </pre>
      </Collapsible>

      <InsightActionDecision
        insightId={insight.id}
        insightStatus={insight.status}
        action={action}
        sentence={sentence}
      />
    </div>
  );
}
