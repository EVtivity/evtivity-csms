// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, RefreshCw, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import {
  INSIGHT_FEEDBACK_REASON_MAX_LENGTH,
  isVisibleInsightStatus,
} from '@evtivity/lib/ai-insights';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { IconBadge } from '@/components/ui/icon-badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { useHasPermission } from '@/lib/auth';
import { insightStatusVariant } from '@/lib/status-variants';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { formatDateTime, formatRelativeTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import { aiRequestErrorText } from '../ai-error-text';
import { InsightActionSection } from './InsightAction';
import { stepsBesideAction } from './insight-action';
import type { AiInsightView } from './insight-api';
import {
  isSummaryInsight,
  useClearInsightFeedback,
  useDismissInsight,
  useInsight,
  useInsightFeedback,
  useRegenerateInsight,
} from './insight-api';
import { INSIGHT_ICONS, insightHeadline } from './insight-display';

interface InsightCardProps {
  insight: AiInsightView;
  /**
   * Shows the insight's one status badge in the eyebrow (default). The detail
   * page shows it in its header instead, so a view never shows two.
   */
  showStatus?: boolean;
  /** Shows the headline (default). The detail page has it as its title instead. */
  showHeadline?: boolean;
  /** "Ask a follow-up" opens the assistant about the record. Hidden when omitted. */
  onFollowUp?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * One automatic insight: the shared card with a left accent in the kind's tone.
 * Top to bottom: an eyebrow (kind icon, "Automatic insight", the one status
 * badge of the insight and its action, confidence, relative time), the headline built from structured
 * fields (the same builder as the dashboard card), the summary as plain
 * text (the only model text, never markdown or links), a label and value list
 * (likely cause, suggested fixes), and a footer with the
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
  showStatus = true,
  showHeadline = true,
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
  // action waits (status pending), Reject is the way to drop it (Dismiss is
  // hidden). Dismiss is for an open insight only.
  const hasAction = insight.action != null;
  const canRegenerate =
    !hasAction && insight.status !== 'analyzing' && insight.status !== 'dismissed';
  const canDismiss = insight.status === 'open';
  // The generation runs: a skeleton, never a status badge (internal state).
  const pending = insight.status === 'analyzing';
  const visibleStatus = isVisibleInsightStatus(insight.status) ? insight.status : null;
  const stale = insight.stale && insight.status !== 'resolved';
  const brief = insight.status === 'skipped' || insight.status === 'failed' || stale;
  const category = summaryKind || insight.category == null ? null : insight.category;

  const regenerateButton =
    canWrite && canRegenerate && (brief || insight.status === 'resolved') ? (
      <Button
        type="button"
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
  const steps = stepsBesideAction(insight.fixes, insight.action);
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
        <h3 className="text-xs font-semibold text-muted-foreground">{t('aiInsights.title')}</h3>
        {showStatus && visibleStatus != null && (
          <Badge variant={insightStatusVariant(visibleStatus)} data-testid="ai-insight-status">
            {t(`aiInsights.status.${visibleStatus}`)}
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

      {showHeadline && (
        <p
          className="text-base font-semibold leading-snug wrap-anywhere"
          data-testid="ai-insight-headline"
        >
          {insightHeadline(t, insight)}
        </p>
      )}

      {pending ? (
        <div className="space-y-3" role="status" aria-label={t('aiInsights.analyzing')}>
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
                      : t('aiInsights.skipped'),
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
          {category != null && (
            <DescriptionList>
              <DescriptionItem
                label={t('aiInsights.likelyCause')}
                valueTestId="ai-insight-category"
              >
                {t(`aiInsights.category.${category}`)}
              </DescriptionItem>
            </DescriptionList>
          )}
        </>
      )}

      {!pending && (insight.action != null || steps.length > 0) && (
        // One Suggested Fix: the executable action first, then the other steps as plain text.
        <section
          aria-label={t('aiInsights.fixesLabel')}
          data-testid="ai-insight-fix"
          className="space-y-3 border-t pt-4"
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="text-sm font-semibold">{t('aiInsights.fixesLabel')}</h3>
            {insight.status === 'pending' && insight.action != null && (
              <span
                className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground"
                data-testid="ai-insight-action-expiry"
              >
                {t('aiInsights.action.expiresAt', {
                  time: formatDateTime(insight.action.expiresAt, timezone),
                })}
                <InfoTooltip
                  content={<div className="max-w-64">{t('aiInsights.action.expiresInfo')}</div>}
                />
              </span>
            )}
          </div>
          {steps.length > 0 && (
            <ul className="list-disc space-y-1 pl-5" data-testid="ai-insight-fixes">
              {steps.map((fix) => (
                <li key={fix.code}>
                  {t(`aiInsights.fix.${fix.code}`)}
                  {fix.note != null && fix.note !== '' && (
                    <span className="block break-words text-xs text-muted-foreground">
                      {fix.note}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <InsightActionSection insight={insight} />
        </section>
      )}

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
            {canDismiss && (
              <Button
                type="button"
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
              variant="outline"
              onClick={onFollowUp}
              data-testid="ai-insight-follow-up"
            >
              <MessageSquare className="h-4 w-4" />
              {t('ai.explain.followUp')}
            </Button>
          )}
          {regenerateButton}
          {canWrite && canDismiss && (
            <Button
              type="button"
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
                  size="icon"
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
                  size="icon"
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
