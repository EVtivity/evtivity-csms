// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { keyArguments } from '@/components/ai/ConfirmActionCard';
import { CodeBlock } from '@/components/ai/CodeBlock';
import { aiRequestErrorText } from '@/components/ai/ai-error-text';
import { proposalActionLabel, proposalSentence } from '@/components/ai/inbox/ProposalCard';
import { ProposalDecision } from '@/components/ai/inbox/ProposalDecision';
import { useProposal } from '@/components/ai/inbox/proposal-api';
import type { AiProposalView } from '@/components/ai/inbox/proposal-api';
import { readProposalSummary } from '@/components/ai/inbox/proposal-summary';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { IdText } from '@/components/ui/id-text';
import { LoadingLogo } from '@/components/loading-logo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { aiProposalStatusVariant, httpMethodVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </>
  );
}

function Fields({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">{children}</dl>;
}

function DetailCard({
  title,
  testId,
  className,
  children,
}: {
  title: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card data-testid={testId} className={cn('min-w-0', className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function RationaleCard({ proposal }: { proposal: AiProposalView }): React.JSX.Element | null {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { rationale, measured } = readProposalSummary(proposal.summary);
  const minutes = rationale?.params['minutes'];
  const text =
    proposal.rationaleText != null && proposal.rationaleText !== '' ? proposal.rationaleText : null;
  const hasMeasured =
    minutes != null ||
    measured.lastActivityAt != null ||
    measured.faultedSince != null ||
    measured.transactionId != null;
  if (rationale == null && text == null && !hasMeasured) return null;
  return (
    <DetailCard title={t('aiInbox.rationale')} testId="ai-proposal-rationale-card">
      {rationale != null && (
        <p className="text-sm" data-testid="ai-proposal-rationale">
          {t(`aiWorkers.rationale.${rationale.code}`, rationale.params)}
        </p>
      )}
      {text != null && <p className="whitespace-pre-line break-words text-sm">{text}</p>}
      {hasMeasured && (
        <Fields>
          {minutes != null && (
            <Row label={t('aiInbox.measured.idleTime')}>
              {t('aiInbox.measured.minutes', { count: Number(minutes) })}
            </Row>
          )}
          {measured.lastActivityAt != null && (
            <Row label={t('aiInbox.measured.lastActivity')}>
              {formatDateTime(measured.lastActivityAt, timezone)}
            </Row>
          )}
          {measured.faultedSince != null && (
            <Row label={t('aiInbox.measured.faultedSince')}>
              {formatDateTime(measured.faultedSince, timezone)}
            </Row>
          )}
          {measured.transactionId != null && (
            <Row label={t('aiInbox.measured.transactionId')}>
              <IdText value={measured.transactionId} />
            </Row>
          )}
        </Fields>
      )}
    </DetailCard>
  );
}

/**
 * One AI proposal (`/ai/inbox/:id`), laid out like the other detail pages:
 * the header with back, action title and status, Confirm and Reject in the
 * header action row (behind the standard dialog, `aiProposals:write`), then
 * the summary, rationale, target, request, timing and argument cards and
 * the History. It is also the approval page an MCP client sends its user to
 * (URL-mode elicitation): the
 * requesting key and client names (untrusted, shown as data) and the full
 * arguments are on screen before Confirm. The API answers 404 to anyone but
 * the requester of an MCP proposal.
 */
export function AiInboxDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { proposal, isLoading, error } = useProposal(id);

  if (isLoading) return <LoadingLogo />;
  if (proposal == null) {
    return (
      <div className="space-y-6">
        <BackButton to="/ai/inbox" />
        <p className="text-sm text-destructive">{aiRequestErrorText(error, t)}</p>
      </div>
    );
  }

  const structured = readProposalSummary(proposal.summary);
  const sentence = proposalSentence(t, proposal);
  const keyArgs = keyArguments(proposal.args, proposal.path);
  const clientName = proposal.clientName ?? structured.clientName;
  const argsText = JSON.stringify(proposal.args, null, 2);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <BackButton to="/ai/inbox" />
          <div className="min-w-0">
            <h1
              className="text-2xl md:text-3xl font-bold wrap-anywhere"
              data-testid="ai-proposal-title"
            >
              {proposalActionLabel(t, proposal)}
            </h1>
            <CopyableId id={proposal.id} />
          </div>
          <Badge
            variant={aiProposalStatusVariant(proposal.status)}
            data-testid="ai-proposal-status"
          >
            {t(`aiInbox.status.${proposal.status}`)}
          </Badge>
        </div>
        <ProposalDecision proposal={proposal} sentence={sentence} size="header" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <DetailCard title={t('aiInbox.detail.summary')} testId="ai-proposal-summary-card">
            <p className="text-sm wrap-anywhere" data-testid="ai-proposal-summary">
              {sentence}
            </p>
            <div className="flex items-start gap-2 font-mono text-xs">
              <Badge variant={httpMethodVariant(proposal.method)} className="shrink-0">
                {proposal.method}
              </Badge>
              <span className="break-all">{proposal.path}</span>
            </div>
            {keyArgs.length > 0 && (
              <Fields>
                {keyArgs.map(({ key, value }) => (
                  <Row key={key} label={key}>
                    <IdText value={value} />
                  </Row>
                ))}
              </Fields>
            )}
            {proposal.result != null && (
              <Alert variant={proposal.status === 'executed' ? 'success' : 'destructive'}>
                <AlertDescription>
                  {proposal.status === 'executed'
                    ? t('aiInbox.executed')
                    : t('aiInbox.confirmFailed')}
                  {proposal.result.httpStatus > 0 &&
                    ` (HTTP ${String(proposal.result.httpStatus)})`}
                </AlertDescription>
              </Alert>
            )}
          </DetailCard>

          <RationaleCard proposal={proposal} />

          {argsText !== '{}' && (
            <DetailCard title={t('aiInbox.arguments')} testId="ai-proposal-arguments">
              <CodeBlock code={argsText} language="json" />
            </DetailCard>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <DetailCard title={t('aiInbox.detail.target')}>
            <Fields>
              {proposal.stationId != null && (
                <Row label={t('aiInbox.stationLabel')}>
                  <Link
                    to={`/stations/${proposal.stationId}`}
                    className="text-link hover:underline"
                  >
                    {proposal.stationName ?? proposal.stationId}
                  </Link>
                </Row>
              )}
              {proposal.sessionId != null && (
                <Row label={t('aiInbox.sessionLabel')}>
                  <Link
                    to={`/sessions/${proposal.sessionId}`}
                    className="text-link hover:underline"
                  >
                    {proposal.sessionId}
                  </Link>
                </Row>
              )}
              {proposal.siteId != null && (
                <Row label={t('aiInbox.filters.site')}>
                  <Link to={`/sites/${proposal.siteId}`} className="text-link hover:underline">
                    {proposal.siteName ?? proposal.siteId}
                  </Link>
                </Row>
              )}
              {proposal.precondition != null && (
                <Row label={t('aiInbox.preconditionLabel')}>
                  {t(`aiInbox.precondition.${proposal.precondition.kind}`)}
                </Row>
              )}
            </Fields>
          </DetailCard>

          <DetailCard title={t('aiInbox.requestedBy')} testId="ai-proposal-request">
            <Fields>
              <Row label={t('aiInbox.filters.source')}>
                {t(`aiInbox.source.${proposal.source}`)}
              </Row>
              {proposal.job != null && (
                <Row label={t('aiInbox.filters.job')}>{t(`aiInbox.job.${proposal.job}`)}</Row>
              )}
              {proposal.source === 'mcp' && (
                <>
                  <Row label={t('aiInbox.detail.requester')}>
                    {proposal.requestedByName ?? t('common.na')}
                  </Row>
                  <Row label={t('aiInbox.apiKey')}>
                    <span data-testid="ai-proposal-api-key">
                      {proposal.apiKeyName ?? t('common.na')}
                    </span>
                  </Row>
                  <Row label={t('aiInbox.client')}>
                    <span data-testid="ai-proposal-client">
                      {clientName != null
                        ? `${clientName}${proposal.clientVersion != null ? ` ${proposal.clientVersion}` : ''}`
                        : t('common.na')}
                    </span>
                  </Row>
                  {structured.requestedTool != null && (
                    <Row label={t('aiInbox.requestedTool')}>
                      <span className="font-mono">{structured.requestedTool}</span>
                    </Row>
                  )}
                </>
              )}
            </Fields>
            {proposal.source === 'mcp' && (
              <p className="text-xs text-muted-foreground">{t('aiInbox.untrustedNote')}</p>
            )}
          </DetailCard>

          <DetailCard title={t('aiInbox.detail.timing')}>
            <Fields>
              <Row label={t('common.created')}>{formatDateTime(proposal.createdAt, timezone)}</Row>
              <Row label={t('aiInbox.columns.expires')}>
                {formatDateTime(proposal.expiresAt, timezone)}
              </Row>
              {proposal.decidedAt != null && (
                <Row label={t('aiInbox.detail.decided')}>
                  {formatDateTime(proposal.decidedAt, timezone)}
                  {proposal.decidedByName != null && (
                    <span className="block text-xs text-muted-foreground">
                      {proposal.decidedByName}
                    </span>
                  )}
                </Row>
              )}
              {proposal.executedAt != null && (
                <Row label={t('aiInbox.detail.executedAt')}>
                  {formatDateTime(proposal.executedAt, timezone)}
                </Row>
              )}
            </Fields>
          </DetailCard>
        </div>
      </div>

      <EntityHistoryTab entityType="ai_proposal" entityId={proposal.id} />
    </div>
  );
}
