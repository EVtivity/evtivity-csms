// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Inbox, ShieldAlert } from 'lucide-react';
import { findAiWorkerAction } from '@evtivity/lib/ai-proposals';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { aiProposalStatusVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import { confirmSummary } from '../confirm-summary';
import type { AiProposalView } from './proposal-api';
import { proposalToolName } from './proposal-api';
import { ProposalDecision } from './ProposalDecision';
import { readProposalSummary } from './proposal-summary';

/** The localized sentence of what a proposal runs (`confirm-summary.ts`). */
export function proposalSentence(t: TFunction, proposal: AiProposalView): string {
  const structured = readProposalSummary(proposal.summary);
  return confirmSummary(t, {
    name: structured.toolName ?? proposalToolName(proposal.operationId),
    method: proposal.method,
    path: proposal.path,
    arguments: proposal.args,
  });
}

/** The localized action title of a proposal (`aiInbox.action.*`). */
export function proposalActionLabel(t: TFunction, proposal: AiProposalView): string {
  const structured = readProposalSummary(proposal.summary);
  const kind = structured.action ?? findAiWorkerAction(proposal.operationId)?.kind ?? null;
  return kind != null ? t(`aiInbox.action.${kind}`) : t('ai.confirmTitle');
}

interface ProposalCardProps {
  proposal: AiProposalView;
  className?: string;
}

/**
 * A pending AI proposal inline on a station or session page: the action, its
 * localized sentence (`confirm-summary.ts`), the rationale, and Confirm or
 * Reject behind the standard dialog. Details opens the proposal's page
 * (`/ai/inbox/:id`) with the arguments and the request info.
 */
export function ProposalCard({ proposal, className }: ProposalCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const pending = proposal.status === 'pending';
  const structured = readProposalSummary(proposal.summary);
  const sentence = proposalSentence(t, proposal);

  return (
    <article
      aria-label={sentence}
      data-testid="ai-proposal-card"
      className={cn(
        'space-y-3 rounded-lg border p-4 text-sm',
        pending ? 'border-warning bg-warning/10' : 'border-border bg-card',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="font-medium">{proposalActionLabel(t, proposal)}</span>
        <Badge variant={aiProposalStatusVariant(proposal.status)} data-testid="ai-proposal-status">
          {t(`aiInbox.status.${proposal.status}`)}
        </Badge>
        {proposal.job != null && (
          <Badge variant="outline">{t(`aiInbox.job.${proposal.job}`)}</Badge>
        )}
        {pending && (
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {t('aiInbox.expiresAt', { time: formatDateTime(proposal.expiresAt, timezone) })}
          </span>
        )}
      </div>

      <p className="wrap-anywhere" data-testid="ai-proposal-summary">
        {sentence}
      </p>

      {structured.rationale != null && (
        <p className="text-muted-foreground" data-testid="ai-proposal-rationale">
          {t(`aiWorkers.rationale.${structured.rationale.code}`, structured.rationale.params)}
        </p>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link
          to={`/ai/inbox/${proposal.id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          data-testid="ai-proposal-details"
        >
          <Inbox className="h-4 w-4" />
          {t('common.details')}
        </Link>
        <ProposalDecision proposal={proposal} sentence={sentence} size="sm" />
      </div>
    </article>
  );
}
