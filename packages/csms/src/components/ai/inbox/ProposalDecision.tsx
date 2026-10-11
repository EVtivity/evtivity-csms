// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Ban, Check } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useHasPermission } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { aiRequestErrorText } from '../ai-error-text';
import type { AiProposalView } from './proposal-api';
import { useDecideProposal } from './proposal-api';

/** Whether a proposal can still be confirmed or rejected now. */
export function isProposalOpen(proposal: AiProposalView, now: number = Date.now()): boolean {
  return proposal.status === 'pending' && Date.parse(proposal.expiresAt) > now;
}

interface ProposalDecisionProps {
  proposal: AiProposalView;
  /** The localized sentence of the action, repeated in the confirm dialog. */
  sentence: string;
  /** `header`: the detail page header row; `sm`: the inline card on a record page. */
  size?: 'header' | 'sm';
  className?: string;
}

/**
 * Confirm and Reject of an AI proposal, each behind the standard
 * ConfirmDialog.
 * Confirm sends the `argsHash` the user saw, so a proposal that changed since
 * cannot run. Hidden without `aiProposals:write` and once the proposal is
 * decided or expired. A refusal (stale, expired, already decided) shows
 * inline; a decision that went through raises a toast that closes on its own.
 */
export function ProposalDecision({
  proposal,
  sentence,
  size = 'header',
  className,
}: ProposalDecisionProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canWrite = useHasPermission('aiProposals:write');
  const decide = useDecideProposal();
  const [dialog, setDialog] = useState<'confirm' | 'reject' | null>(null);
  if (!canWrite) return null;
  const open = isProposalOpen(proposal);
  if (!open && decide.error == null) return null;

  function run(verb: 'confirm' | 'reject'): void {
    const decision =
      verb === 'confirm'
        ? { verb, id: proposal.id, argsHash: proposal.argsHash }
        : { verb, id: proposal.id };
    decide.mutate(decision, {
      onSuccess: (result) => {
        setDialog(null);
        if (verb === 'reject') {
          toast({ variant: 'success', title: t('aiInbox.rejectedToast') });
        } else if (result.status === 'executed') {
          toast({ variant: 'success', title: t('aiInbox.executed') });
        } else {
          toast({ variant: 'destructive', title: t('aiInbox.confirmFailed') });
        }
      },
      onError: () => {
        setDialog(null);
      },
    });
  }

  return (
    <div className={cn('space-y-2', className)}>
      {open && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={decide.isPending}
            data-testid="ai-proposal-reject"
            onClick={() => {
              decide.reset();
              setDialog('reject');
            }}
          >
            <Ban className="h-4 w-4" />
            {t('aiInbox.reject')}
          </Button>
          <Button
            type="button"
            size={size}
            disabled={decide.isPending}
            data-testid="ai-proposal-confirm"
            onClick={() => {
              decide.reset();
              setDialog('confirm');
            }}
          >
            <Check className="h-4 w-4" />
            {t('aiInbox.confirm')}
          </Button>
        </div>
      )}
      {decide.error != null && (
        <Alert variant="destructive" role="alert" data-testid="ai-proposal-error">
          <AlertCircle />
          <AlertDescription>{aiRequestErrorText(decide.error, t)}</AlertDescription>
        </Alert>
      )}
      <ConfirmDialog
        open={dialog === 'confirm'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={t('aiInbox.confirmDialog.title')}
        description={sentence}
        confirmLabel={t('aiInbox.confirm')}
        confirmIcon={<Check className="h-4 w-4" />}
        variant="default"
        isPending={decide.isPending}
        onConfirm={() => {
          run('confirm');
          return false;
        }}
      >
        <p className="text-sm text-muted-foreground">{t('aiInbox.confirmDialog.note')}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'reject'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={t('aiInbox.rejectDialog.title')}
        description={sentence}
        confirmLabel={t('aiInbox.reject')}
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
