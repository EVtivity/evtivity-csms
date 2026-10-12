// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useId, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { MessageSquare, RefreshCw, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { INSIGHT_FEEDBACK_REASON_MAX_LENGTH } from '@evtivity/lib/ai-insights';
import type { InsightScopeCounts } from '@evtivity/lib/ai-insights';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { IconBadge } from '@/components/ui/icon-badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { formatNumber } from '@/lib/formatting';
import { useHasPermission } from '@/lib/auth';
import { formatRelativeTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import { aiRequestErrorText } from '../ai-error-text';
import { InsightActionSection } from './InsightAction';
import type { AiInsightView } from './insight-api';
import {
  isSummaryInsight,
  useClearInsightFeedback,
  useDismissInsight,
  useInsight,
  useInsightFeedback,
  useInsightScopeNow,
  useRegenerateInsight,
} from './insight-api';
import { INSIGHT_ICONS, fixPath, insightHeadline, insightSize } from './insight-display';

const SCOPE_KEYS = [
  'stations',
  'stationsOffline',
  'stationsFaulted',
  'sameErrorCode',
  'sessionsInterrupted',
  'sessionsFailedSameReason24h',
  'tokenRefusals',
] as const satisfies readonly (keyof InsightScopeCounts)[];

interface ScopeRow {
  key: string;
  label: string;
  then: number;
  now: number | null;
}

/** One row per measure of the site counts, labelled by the measure alone. */
function scopeRows(
  t: TFunction,
  counts: InsightScopeCounts | undefined,
  now: InsightScopeCounts | undefined,
): ScopeRow[] {
  if (counts == null) return [];
  return SCOPE_KEYS.filter((k) => (counts[k] ?? 0) > 0 || (now?.[k] ?? 0) > 0).map((k) => ({
    key: k,
    label: t(`aiInsights.scopeTable.measure.${k}`),
    then: counts[k] ?? 0,
    now: now == null ? null : (now[k] ?? 0),
  }));
}

/** The measure the collapsed summary names: the insight's size, else the first row. */
function mainMeasure(
  insight: AiInsightView,
): { key: (typeof SCOPE_KEYS)[number]; then: number } | null {
  const size = insightSize(insight);
  if (size != null) return { key: size.key, then: size.count };
  const counts = insight.scope.site;
  const key = SCOPE_KEYS.find((k) => (counts?.[k] ?? 0) > 0);
  return key == null ? null : { key, then: counts?.[key] ?? 0 };
}

/**
 * The scope figures, collapsed by default (`Collapsible`). Closed, the
 * trigger names the main measure at detection. Opening it asks for the
 * counts now (lazy, SQL only) and shows the table: one row per measure, the
 * value the analysis used ("At detection") and the value now, a skeleton in
 * the Now column while it loads. The counts are the subject site's ("Site
 * context"). A changed value is medium weight, nothing else marks it.
 */
function ScopeSection({ insight }: { insight: AiInsightView }): React.JSX.Element | null {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [open, setOpen] = useState(false);
  const live = useInsightScopeNow(insight.id, open);
  const now = live.scopeNow;
  const rows = scopeRows(t, insight.scope.site, now?.site ?? undefined);
  if (rows.length === 0) return null;
  const main = mainMeasure(insight);
  let summary: string | null = null;
  if (main != null) {
    const value = t(`aiInsights.scope.${main.key}`, { count: main.then });
    const current = now?.site?.[main.key];
    summary =
      current == null
        ? t('aiInsights.scopeTable.summaryAtDetection', { value })
        : current === main.then
          ? value
          : t('aiInsights.scopeTable.summaryChanged', { value, now: formatNumber(current, 0) });
  }
  return (
    <Collapsible
      title={t('aiInsights.scopeTable.title')}
      summary={summary}
      onOpenChange={setOpen}
      data-testid="ai-insight-scope-section"
    >
      <Table data-testid="ai-insight-scope">
        <TableHeader>
          <TableRow>
            <TableHead>{t('aiInsights.scopeTable.measureHeader')}</TableHead>
            <TableHead className="text-right">
              <span className="inline-flex items-center gap-1">
                {t('aiInsights.scopeTable.atDetection')}
                <InfoTooltip content={t('aiInsights.scopeTable.atDetectionHint')} />
              </span>
            </TableHead>
            <TableHead className="text-right">
              <span className="inline-flex items-center gap-1">
                {t('aiInsights.scopeTable.now')}
                {live.scopeNowAt != null && (
                  <InfoTooltip
                    content={t('aiInsights.scopeTable.nowHint', {
                      time: formatRelativeTime(live.scopeNowAt, timezone),
                    })}
                  />
                )}
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="py-2">{row.label}</TableCell>
              <TableCell className="py-2 text-right tabular-nums">
                {formatNumber(row.then, 0)}
              </TableCell>
              <TableCell
                className={cn(
                  'py-2 text-right tabular-nums',
                  row.now != null && row.now !== row.then && 'font-medium',
                )}
              >
                {live.isLoading ? (
                  <Skeleton className="ml-auto h-4 w-8" data-testid="ai-insight-scope-loading" />
                ) : row.now == null ? (
                  '-'
                ) : (
                  formatNumber(row.now, 0)
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Collapsible>
  );
}

export interface InsightCardProps {
  insight: AiInsightView;
  /** "Ask a follow-up" opens the assistant about the record. Hidden when omitted. */
  onFollowUp?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * One automatic insight: the shared card with a left accent in the kind's tone.
 * Top to bottom: an eyebrow (kind icon, "Automatic insight", status and
 * confidence badges, relative time), the headline built from structured
 * fields (the same builder as the dashboard card), the summary as plain
 * text (the only model text, never markdown or links), a label and value list
 * (likely cause, suggested fixes, scope chips), and a footer with the
 * translation note, the helpful count and the actions. No provider or model
 * name (D14). Helpful and Wrong are one vote per user: the chosen thumb is
 * pressed (`aria-pressed`) and pressing it again removes the vote. Wrong
 * opens an optional note (stored only, never sent to a model) with
 * Regenerate and Dismiss right there.
 * Analyzing shows a skeleton of the same shape; skipped, failed or out of
 * date shows one muted line with Regenerate where allowed.
 */
export function InsightCard({
  insight: given,
  onFollowUp,
  className,
}: InsightCardProps): React.JSX.Element {
  // The detail answer asks for the summary in the UI language (a missing
  // translation is requested on the server) and is refetched by the SSE event
  // `ai.insight.updated` when it is ready, so a card fed by a list swaps to the
  // translation in place. The detail page passes the same query's data.
  const { insight: detail } = useInsight(given.id);
  const insight = detail ?? given;
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('aiInsights:write');
  const regenerate = useRegenerateInsight();
  const dismiss = useDismissInsight();
  const feedback = useInsightFeedback();
  const clearFeedback = useClearInsightFeedback();
  const [showOriginal, setShowOriginal] = useState(false);
  // The Wrong panel opens when the user marks the insight wrong here.
  const [wrongOpen, setWrongOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonSaved, setReasonSaved] = useState(false);
  const reasonId = useId();

  // "A new insight is being prepared" lasts until the insight changes (SSE or a refetch).
  const version = `${insight.id}|${insight.status}|${insight.basisAt ?? ''}|${insight.summary ?? ''}`;
  const seenVersion = useRef(version);
  const resetRegenerate = regenerate.reset;
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    resetRegenerate();
  }, [version, resetRegenerate]);

  const { icon, tone } = INSIGHT_ICONS[insight.kind];
  const original =
    insight.originalSummary != null && insight.originalSummary !== ''
      ? insight.originalSummary
      : null;
  const translated = insight.summary != null && insight.summary !== '' ? insight.summary : null;
  // Until the translation arrives (or when none can be made) the canonical text shows.
  const waiting = insight.textStatus !== 'ready' && translated == null;
  // A rule insight (or a worker run without a narrative) has no text at all: no note.
  const showTextNote = waiting && (insight.textStatus === 'pending' || original != null);
  const summaryKind = isSummaryInsight(insight);
  const hasOriginal = !waiting && original != null && original !== translated;
  const summary = waiting || showOriginal ? original : translated;
  const actionError = regenerate.error ?? dismiss.error ?? feedback.error ?? clearFeedback.error;
  const busy =
    regenerate.isPending || dismiss.isPending || feedback.isPending || clearFeedback.isPending;
  const mine = insight.feedback?.mine ?? null;
  const helpfulCount = insight.feedback?.helpfulCount ?? 0;
  // A worker suggestion is regenerated by its job, never by hand; while its
  // action waits, Reject is the way to drop it (Dismiss is hidden).
  const hasAction = insight.action != null;
  const actionPending = insight.action?.status === 'pending';
  const canRegenerate =
    !hasAction && insight.status !== 'pending' && insight.status !== 'dismissed';
  const pending = insight.status === 'pending';
  const stale = insight.stale && insight.status !== 'resolved';
  const brief = insight.status === 'skipped' || insight.status === 'failed' || stale;
  const category = summaryKind || insight.category == null ? null : insight.category;

  const regenerateButton =
    canWrite && canRegenerate && (brief || insight.status === 'resolved') ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        data-testid="ai-insight-regenerate"
        onClick={() => {
          regenerate.mutate({ id: insight.id });
        }}
      >
        {regenerate.isPending ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
        {t('aiInsights.regenerate')}
      </Button>
    ) : null;

  // One vote per user: pressing the chosen thumb again removes the vote.
  const vote = (helpful: boolean): void => {
    setReasonSaved(false);
    if (mine === helpful) {
      clearFeedback.mutate({ id: insight.id });
      setWrongOpen(false);
      return;
    }
    feedback.mutate({ id: insight.id, body: { helpful } });
    setWrongOpen(!helpful);
  };
  const saveReason = (): void => {
    feedback.mutate(
      { id: insight.id, body: { helpful: false, reason: reason.trim() === '' ? null : reason } },
      {
        onSuccess: () => {
          setReasonSaved(true);
        },
      },
    );
  };
  const showWrongPanel = canWrite && wrongOpen && mine !== true && !pending && !brief;

  return (
    <Card
      accent={tone}
      aria-label={t('aiInsights.title')}
      aria-busy={pending || undefined}
      data-testid="ai-insight-card"
      className={cn('space-y-4 p-6 text-sm', className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <IconBadge icon={icon} tone={tone} size="sm" />
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('aiInsights.title')}
        </h3>
        {pending && <Badge variant="info">{t('aiInsights.status.pending')}</Badge>}
        {insight.status === 'resolved' && (
          <Badge variant="success" data-testid="ai-insight-resolved">
            {t('aiInsights.badge.resolved')}
          </Badge>
        )}
        {stale && (
          <Badge variant="outline" data-testid="ai-insight-stale">
            {t('aiInsights.badge.outOfDate')}
          </Badge>
        )}
        {insight.generatedBy === 'rule' && (
          <Badge variant="outline">{t('aiInsights.knownCause')}</Badge>
        )}
        {!pending && !brief && category != null && insight.confidence != null && (
          <Badge variant="outline">{t(`aiInsights.confidenceBadge.${insight.confidence}`)}</Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelativeTime(insight.basisAt ?? insight.createdAt, timezone)}
        </span>
      </div>

      <p
        className="text-base font-semibold leading-snug wrap-anywhere"
        data-testid="ai-insight-headline"
      >
        {insightHeadline(t, insight)}
      </p>

      {pending ? (
        <div className="space-y-3" role="status" aria-label={t('aiInsights.status.pending')}>
          <Skeleton className="h-4 w-full max-w-[65ch]" />
          <Skeleton className="h-4 w-4/5 max-w-[52ch]" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
      ) : brief ? (
        <p className="text-muted-foreground" data-testid="ai-insight-brief">
          {stale
            ? t('aiInsights.staleNote')
            : insight.status === 'failed'
              ? t('aiInsights.failedNote')
              : t('aiInsights.skippedNote', {
                  reason:
                    insight.skipReason != null
                      ? t(`aiInsights.skipReason.${insight.skipReason}`)
                      : t('aiInsights.status.skipped'),
                })}
        </p>
      ) : (
        <>
          {summary != null && (
            <p
              className="max-w-[65ch] whitespace-pre-line break-words leading-relaxed"
              data-testid="ai-insight-summary"
            >
              {summary}
            </p>
          )}
          {(category != null || insight.fixes.length > 0) && (
            <DescriptionList>
              {category != null && (
                <DescriptionItem
                  label={t('aiInsights.likelyCause')}
                  valueTestId="ai-insight-category"
                >
                  {t(`aiInsights.category.${category}`)}
                </DescriptionItem>
              )}
              {insight.fixes.length > 0 && (
                <DescriptionItem label={t('aiInsights.fixesLabel')}>
                  <ul className="space-y-1" data-testid="ai-insight-fixes">
                    {insight.fixes.map((fix) => {
                      const path = fixPath(fix.code, insight);
                      const label = t(`aiInsights.fix.${fix.code}`);
                      return (
                        <li key={fix.code}>
                          {path != null ? (
                            <Link to={path} className="text-link hover:underline">
                              {label}
                            </Link>
                          ) : (
                            label
                          )}
                          {fix.note != null && fix.note !== '' && (
                            <span className="block break-words text-xs text-muted-foreground">
                              {fix.note}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </DescriptionItem>
              )}
            </DescriptionList>
          )}
          <ScopeSection insight={insight} />
        </>
      )}

      {!pending && <InsightActionSection insight={insight} />}

      {showWrongPanel && (
        <div className="space-y-3 border-t pt-4" data-testid="ai-insight-wrong-panel">
          <p className="text-muted-foreground">{t('aiInsights.feedback.wrongPrompt')}</p>
          <div className="space-y-2">
            <Label htmlFor={reasonId}>{t('aiInsights.feedback.reasonLabel')}</Label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={INSIGHT_FEEDBACK_REASON_MAX_LENGTH}
              placeholder={t('aiInsights.feedback.reasonPlaceholder')}
              aria-describedby={`${reasonId}-hint`}
              data-testid="ai-insight-wrong-reason"
              onChange={(e) => {
                setReason(e.target.value);
                setReasonSaved(false);
              }}
            />
            <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
              {t('aiInsights.feedback.reasonHint')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || reason.trim() === ''}
              data-testid="ai-insight-wrong-save"
              onClick={saveReason}
            >
              {t('aiInsights.feedback.saveReason')}
            </Button>
            {canRegenerate && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="ai-insight-wrong-regenerate"
                onClick={() => {
                  regenerate.mutate({ id: insight.id });
                }}
              >
                {regenerate.isPending ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t('aiInsights.regenerate')}
              </Button>
            )}
            {insight.status === 'active' && !actionPending && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="ai-insight-wrong-dismiss"
                onClick={() => {
                  dismiss.mutate({ id: insight.id });
                }}
              >
                <X className="h-4 w-4" />
                {t('aiInsights.dismiss')}
              </Button>
            )}
            {reasonSaved && (
              <span role="status" className="text-xs text-muted-foreground">
                {t('aiInsights.feedback.reasonSaved')}
              </span>
            )}
          </div>
        </div>
      )}

      {actionError != null && (
        <p role="alert" className="text-destructive">
          {aiRequestErrorText(actionError, t)}
        </p>
      )}
      {regenerate.isSuccess && (
        <p className="text-muted-foreground">{t('aiInsights.regenerateQueued')}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
        {showTextNote && (
          <span className="inline-flex items-center gap-1" data-testid="ai-insight-translating">
            {insight.textStatus === 'pending' && <Spinner className="h-3 w-3" />}
            {insight.textStatus === 'pending'
              ? t('aiInsights.summaryTranslating')
              : t('aiInsights.summaryUnavailable')}
          </span>
        )}
        {hasOriginal && !brief && (
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() => {
              setShowOriginal((v) => !v);
            }}
          >
            {showOriginal ? t('aiInsights.hideOriginal') : t('aiInsights.showOriginal')}
          </Button>
        )}
        {helpfulCount > 0 && !pending && (
          <span data-testid="ai-insight-helpful-count">
            {t('aiInsights.feedback.helpfulCount', { count: helpfulCount })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {onFollowUp != null && !pending && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onFollowUp}
              data-testid="ai-insight-follow-up"
            >
              <MessageSquare className="h-4 w-4" />
              {t('ai.explain.followUp')}
            </Button>
          )}
          {regenerateButton}
          {canWrite && insight.status === 'active' && !actionPending && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                dismiss.mutate({ id: insight.id });
              }}
            >
              <X className="h-4 w-4" />
              {t('aiInsights.dismiss')}
            </Button>
          )}
          {canWrite && !pending && !brief && (
            <>
              <Tooltip
                content={
                  mine === true ? t('aiInsights.feedback.removeVote') : t('aiInsights.helpful')
                }
              >
                <Button
                  type="button"
                  size="icon-sm"
                  variant={mine === true ? 'default' : 'outline'}
                  aria-label={t('aiInsights.helpful')}
                  aria-pressed={mine === true}
                  disabled={busy}
                  data-testid="ai-insight-helpful"
                  onClick={() => {
                    vote(true);
                  }}
                >
                  <ThumbsUp className="h-4 w-4" />
                </Button>
              </Tooltip>
              <Tooltip
                content={
                  mine === false ? t('aiInsights.feedback.removeVote') : t('aiInsights.wrong')
                }
              >
                <Button
                  type="button"
                  size="icon-sm"
                  variant={mine === false ? 'default' : 'outline'}
                  aria-label={t('aiInsights.wrong')}
                  aria-pressed={mine === false}
                  disabled={busy}
                  data-testid="ai-insight-wrong"
                  onClick={() => {
                    vote(false);
                  }}
                >
                  <ThumbsDown className="h-4 w-4" />
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
