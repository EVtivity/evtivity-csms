// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Ban, Check, ShieldAlert } from 'lucide-react';
import { isAiProposalRefusalReason } from '@evtivity/lib/ai-proposals';
import { keyArguments } from '@/components/ai/ConfirmActionCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { IdText } from '@/components/ui/id-text';
import { useToast } from '@/components/ui/toast';
import { useHasPermission } from '@/lib/auth';
import { insightActionStatusVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { aiRequestErrorText } from '../ai-error-text';
import type { AiInsightActionView, AiInsightView } from './insight-api';
import { useDecideInsightAction } from './insight-api';
import { actionLabel, actionSentence, isActionOpen, readActionSummary } from './insight-action';

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
  action,
  sentence,
}: {
  insightId: string;
  action: AiInsightActionView;
  sentence: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canWrite = useHasPermission('aiInsights:write');
  const decide = useDecideInsightAction();
  const [dialog, setDialog] = useState<'confirm' | 'reject' | null>(null);
  if (!canWrite) return null;
  const open = isActionOpen(action);
  if (!open && decide.error == null) return null;

  function run(verb: 'confirm' | 'reject'): void {
    const decision =
      verb === 'confirm' ? { verb, insightId, argsHash: action.argsHash } : { verb, insightId };
    decide.mutate(decision, {
      onSuccess: (result) => {
        setDialog(null);
        if (verb === 'reject') {
          toast({ variant: 'success', title: t('aiInsights.action.rejectedToast') });
        } else if (result.action?.status === 'executed') {
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
      {open && (
        <div className="flex flex-wrap justify-end gap-2" data-testid="ai-action-buttons">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={decide.isPending}
            data-testid="ai-action-reject"
            onClick={() => {
              decide.reset();
              setDialog('reject');
            }}
          >
            <Ban className="h-4 w-4" />
            {t('aiInsights.action.reject')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={decide.isPending}
            data-testid="ai-action-confirm"
            onClick={() => {
              decide.reset();
              setDialog('confirm');
            }}
          >
            <Check className="h-4 w-4" />
            {t('aiInsights.action.confirm')}
          </Button>
        </div>
      )}
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
 * insight card: what runs (the localized sentence), its status and expiry,
 * the rationale and the measured values, the key arguments, the full
 * arguments with the shared copy button, the result, and Reject and Confirm.
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
  const pending = action.status === 'pending';
  const sentence = actionSentence(t, action);
  const { rationale, measured } = readActionSummary(action.summary);
  const minutes = rationale?.params['minutes'];
  const keyArgs = keyArguments(action.args, action.path);
  const argsText = JSON.stringify(action.args, null, 2);
  // An action refused at confirm stores only the reason code (no English text).
  const refused = (action.result?.body as { refused?: unknown } | null | undefined)?.refused;
  const refusal = isAiProposalRefusalReason(refused) ? refused : null;

  return (
    <section
      aria-label={actionLabel(t, action)}
      data-testid="ai-insight-action"
      className="space-y-3 border-t pt-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('aiInsights.action.title')}
        </span>
        <span className="font-semibold">{actionLabel(t, action)}</span>
        <Badge
          variant={insightActionStatusVariant(action.status)}
          data-testid="ai-insight-action-status"
        >
          {t(`aiInsights.action.status.${action.status}`)}
        </Badge>
        {pending && (
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {t('aiInsights.action.expiresAt', {
              time: formatDateTime(action.expiresAt, timezone),
            })}
          </span>
        )}
      </div>

      <p className="wrap-anywhere" data-testid="ai-insight-action-summary">
        {sentence}
      </p>

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
        {measured.transactionId != null && (
          <DescriptionItem label={t('aiInsights.action.measured.transactionId')}>
            <IdText value={measured.transactionId} />
          </DescriptionItem>
        )}
        {action.precondition != null && (
          <DescriptionItem label={t('aiInsights.action.preconditionLabel')}>
            {t(`aiInsights.action.precondition.${action.precondition.kind}`)}
          </DescriptionItem>
        )}
        {keyArgs.map(({ key, value }) => (
          <DescriptionItem key={key} label={key}>
            <IdText value={value} />
          </DescriptionItem>
        ))}
      </DescriptionList>

      {argsText !== '{}' && (
        <div
          className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background"
          data-testid="ai-insight-action-arguments"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-muted-foreground">
            <span>{t('aiInsights.action.arguments')}</span>
            <CopyButton value={argsText} label={t('aiInsights.action.arguments')} />
          </div>
          <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
            <code className="font-mono">{argsText}</code>
          </pre>
        </div>
      )}

      {action.result != null && (
        <Alert variant={action.status === 'executed' ? 'success' : 'destructive'}>
          <AlertDescription>
            {action.status === 'executed'
              ? t('aiInsights.action.executed')
              : t('aiInsights.action.confirmFailed')}
            {action.result.httpStatus > 0 && ` (HTTP ${String(action.result.httpStatus)})`}
            {refusal !== null && (
              <span className="block" data-testid="ai-insight-action-refusal">
                {t(`aiInsights.action.refused.${refusal}`)}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      <InsightActionDecision insightId={insight.id} action={action} sentence={sentence} />
    </section>
  );
}
