// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useCanExplain, useOpenExplain } from '@/components/ai/ExplainButton';
import { aiRequestErrorText } from '@/components/ai/ai-error-text';
import { InsightCard } from '@/components/ai/insights/InsightCard';
import { useInsight } from '@/components/ai/insights/insight-api';
import type { AiInsightView } from '@/components/ai/insights/insight-api';
import { insightHeadline } from '@/components/ai/insights/insight-display';
import type { AiPanelContext } from '@/components/ai/use-ai-panel-store';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { insightStatusVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

function explainContext(insight: AiInsightView): AiPanelContext | undefined {
  if (insight.sessionId != null) return { kind: 'session', id: insight.sessionId };
  if (insight.stationId != null) {
    return insight.stationName != null
      ? { kind: 'station', id: insight.stationId, label: insight.stationName }
      : { kind: 'station', id: insight.stationId };
  }
  return undefined;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </>
  );
}

/**
 * One insight (`/ai/insights/:id`, `aiInsights:read`): the standard detail
 * header (back, headline, status, Prev and Next in the list order), the
 * insight card (with the action a background worker suggested, and Reject
 * and Confirm), the records it is about with the action's job, target,
 * precondition and timing, and the history (`ai_insight` audit rows, and the
 * action's `ai_proposal` rows). Rows of the dashboard card and of the
 * insights list open it.
 */
export function AiInsightDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { insight, isLoading, error } = useInsight(id ?? null);
  const canExplain = useCanExplain();
  const open = useOpenExplain();

  if (isLoading) return <LoadingLogo />;
  if (insight == null) {
    return (
      <div className="space-y-6">
        <BackButton to="/ai/insights" />
        <p className="text-sm text-destructive">{aiRequestErrorText(error, t)}</p>
      </div>
    );
  }
  const context = explainContext(insight);
  const action = insight.action;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/ai/insights" />
        <div className="min-w-0">
          <h1
            className="text-2xl md:text-3xl font-bold wrap-anywhere"
            data-testid="ai-insight-title"
          >
            {insightHeadline(t, insight)}
          </h1>
          <CopyableId id={insight.id} />
        </div>
        <Badge variant={insightStatusVariant(insight.status)} data-testid="ai-insight-status">
          {t(`aiInsights.status.${insight.status}`)}
        </Badge>
        <EntityNavButtons resource="ai/insights" basePath="/ai/insights" currentId={insight.id} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <InsightCard
          insight={insight}
          className="min-w-0 lg:col-span-2"
          onFollowUp={
            canExplain && context != null
              ? () => {
                  open(context);
                }
              : undefined
          }
        />
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{t('aiInsights.detail.recordTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label={t('aiInsights.list.kind')}>{t(`aiInsights.kind.${insight.kind}`)}</Row>
              {insight.stationId != null && (
                <Row label={t('aiInsights.list.station')}>
                  <Link to={`/stations/${insight.stationId}`} className="text-link hover:underline">
                    {insight.stationName ?? insight.stationId}
                  </Link>
                </Row>
              )}
              {insight.sessionId != null && (
                <Row label={t('aiInsights.detail.session')}>
                  <Link to={`/sessions/${insight.sessionId}`} className="text-link hover:underline">
                    {insight.sessionId}
                  </Link>
                </Row>
              )}
              {insight.siteId != null && (
                <Row label={t('aiInsights.list.site')}>
                  <Link to={`/sites/${insight.siteId}`} className="text-link hover:underline">
                    {insight.siteName ?? insight.siteId}
                  </Link>
                </Row>
              )}
              {insight.parentInsightId != null && (
                <Row label={t('aiInsights.detail.partOf')}>
                  <Link
                    to={`/ai/insights/${encodeURIComponent(insight.parentInsightId)}`}
                    className="text-link hover:underline"
                  >
                    {t('aiInsights.kind.site_incident')}
                  </Link>
                </Row>
              )}
              <Row label={t('common.created')}>{formatDateTime(insight.createdAt, timezone)}</Row>
              {insight.resolvedAt != null && (
                <Row label={t('aiInsights.status.resolved')}>
                  {formatDateTime(insight.resolvedAt, timezone)}
                </Row>
              )}
              {insight.dismissedAt != null && (
                <Row label={t('aiInsights.status.dismissed')}>
                  {formatDateTime(insight.dismissedAt, timezone)}
                </Row>
              )}
              {insight.skipReason != null && (
                <Row label={t('aiInsights.status.skipped')}>
                  {t(`aiInsights.skipReason.${insight.skipReason}`)}
                </Row>
              )}
              {action?.job != null && (
                <Row label={t('aiInsights.action.jobLabel')}>
                  {t(`aiInsights.action.job.${action.job}`)}
                </Row>
              )}
              {action != null && (
                <Row label={t('aiInsights.action.expires')}>
                  {formatDateTime(action.expiresAt, timezone)}
                </Row>
              )}
              {action?.decidedAt != null && (
                <Row label={t('aiInsights.action.decided')}>
                  {formatDateTime(action.decidedAt, timezone)}
                  {action.decidedByName != null && (
                    <span className="block text-xs text-muted-foreground">
                      {action.decidedByName}
                    </span>
                  )}
                </Row>
              )}
              {action?.executedAt != null && (
                <Row label={t('aiInsights.action.executedAt')}>
                  {formatDateTime(action.executedAt, timezone)}
                </Row>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      <EntityHistoryTab entityType="ai_insight" entityId={insight.id} />
      {action != null && (
        <EntityHistoryTab
          entityType="ai_proposal"
          entityId={action.id}
          title={t('aiInsights.action.history')}
        />
      )}
    </div>
  );
}
