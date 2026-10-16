// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  AiRecordContextKind,
  AiInsightDto,
  InsightFeedbackFilter,
  InsightFeedbackRate,
  InsightFeedbackSummary,
  InsightKind,
  RootCauseCategory,
} from '@evtivity/lib/ai-insights';
import { INSIGHT_LIVE_STATUSES } from '@evtivity/lib/ai-insights';
import type { AiProposalDto } from '@evtivity/lib/ai-proposals';
import { toUiLanguage } from '@evtivity/lib/languages';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

/**
 * Automatic insights in the CSMS (`GET /v1/ai/insights`).
 * Every query asks for the summary in the UI language (decision D2): a
 * missing translation comes back `textStatus: 'pending'` and the SSE event
 * `ai.insight.updated` refreshes it (`hooks/event-query-keys.ts`).
 */

/** Root of every insight query; the SSE event invalidates it. */
export const AI_INSIGHTS_KEY = ['ai', 'insights'] as const;

/** The action an insight carries (a background worker suggestion), as the API sends it. */
export interface AiInsightActionView extends AiProposalDto {
  /** The user who confirmed or rejected it. */
  decidedByName?: string | null;
}

/** An insight as the API sends it: the R0 DTO plus the primary-language text. */
export interface AiInsightView extends AiInsightDto {
  action: AiInsightActionView | null;
  /** The canonical summary when `summary` is a translation or missing (Show original). */
  originalSummary?: string | null;
  /** With the `authorizeAttemptIds` filter: the listed attempts this insight covers. */
  matchedAttemptIds?: number[];
  /** OCPP identity of the station, for display. */
  stationName?: string | null;
  /** Name of the site, for display. */
  siteName?: string | null;
  /** OCPP reservation id of the reservation, for display. */
  reservationNumber?: number | null;
  /** The driver of a reservation insight, or the one matched by a refused token. */
  driverId?: string | null;
  /** The driver's name; null without `drivers:read` or when the driver is gone. */
  driverName?: string | null;
  /** The token matched by the refused attempt of an authorization insight. */
  tokenId?: string | null;
  /** The token's idToken; null without `drivers:read` or when the token is gone. */
  tokenLabel?: string | null;
  /** Detail only: the votes (one per user) and the viewer's own vote. */
  feedback?: InsightFeedbackSummary;
  /** `feedbackUsed`, and the viewer asked for the regeneration: the note was theirs. */
  feedbackFromYou?: boolean;
}

export interface InsightFilter {
  stationId?: string;
  sessionId?: string;
  reservationId?: string;
  siteId?: string;
  supportCaseId?: string;
  /** Comma-separated authorize attempt ids, at most 100. */
  authorizeAttemptIds?: string;
  kind?: InsightKind;
  /** One shown status (`InsightVisibleStatus`), or several comma-separated (`open,pending`). */
  status?: string;
  category?: RootCauseCategory;
  /** Insights someone marked helpful, or wrong. */
  feedback?: InsightFeedbackFilter;
  limit?: number;
}

interface InsightList {
  data: AiInsightView[];
  total: number;
}

/** Rows per page of the insights list. */
export const INSIGHTS_PAGE_SIZE = 20;

/** Re-asks for a pending translation in case the SSE event is missed. */
const PENDING_TEXT_REFETCH_MS = 15_000;
const INSIGHT_STALE_TIME_MS = 30_000;
/** A resolved insight stays on the record's page this long. */
/** The most attempt ids the `authorizeAttemptIds` filter takes. */
const MAX_ATTEMPT_IDS = 100;
export const RECENT_INSIGHT_MS = 24 * 60 * 60 * 1000;

function useInsightLanguage(): string {
  const { i18n } = useTranslation();
  return toUiLanguage(i18n.language);
}

function listPath(filter: InsightFilter, language: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  if (!params.has('limit')) params.set('limit', '10');
  params.set('language', language);
  return `/v1/ai/insights?${params.toString()}`;
}

/** Insights matching `filter`, newest first. Disabled without `aiInsights:read`. */
export function useInsights(
  filter: InsightFilter,
  enabled = true,
): {
  insights: AiInsightView[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const canRead = useHasPermission('aiInsights:read');
  const language = useInsightLanguage();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'list', filter, language],
    queryFn: () => api.get<InsightList>(listPath(filter, language)),
    enabled: canRead && enabled,
    staleTime: INSIGHT_STALE_TIME_MS,
    refetchInterval: (query) =>
      query.state.data?.data.some((i) => i.textStatus === 'pending')
        ? PENDING_TEXT_REFETCH_MS
        : false,
  });
  return {
    insights: data?.data ?? [],
    total: data?.total ?? 0,
    isLoading: canRead && enabled && isLoading,
    isError,
    refetch: () => {
      void refetch();
    },
  };
}

/** One page of the insights list (`/ai/insights`), newest first. */
export function useInsightPage(
  filter: Omit<InsightFilter, 'limit'>,
  page: number,
): { insights: AiInsightView[]; total: number; isLoading: boolean; isError: boolean } {
  const canRead = useHasPermission('aiInsights:read');
  const language = useInsightLanguage();
  const { data, isLoading, isError } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'page', filter, page, language],
    queryFn: () =>
      api.get<InsightList>(
        `${listPath({ ...filter, limit: INSIGHTS_PAGE_SIZE }, language)}&page=${String(page)}`,
      ),
    enabled: canRead,
    staleTime: INSIGHT_STALE_TIME_MS,
  });
  return {
    insights: data?.data ?? [],
    total: data?.total ?? 0,
    isLoading: canRead && isLoading,
    isError,
  };
}

/** One insight in the UI language; asks the server for a translation when missing. */
export function useInsight(id: string | null): {
  insight: AiInsightView | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} {
  const canRead = useHasPermission('aiInsights:read');
  const language = useInsightLanguage();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'detail', id, language],
    queryFn: () =>
      api.get<AiInsightView>(
        `/v1/ai/insights/${encodeURIComponent(id ?? '')}?language=${encodeURIComponent(language)}&feedback=true`,
      ),
    enabled: canRead && id != null,
    staleTime: INSIGHT_STALE_TIME_MS,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.textStatus === 'pending' || query.state.data?.status === 'analyzing'
        ? PENDING_TEXT_REFETCH_MS
        : false,
  });
  return { insight: data, isLoading: canRead && id != null && isLoading, isError, error };
}

/**
 * Kinds a background worker writes about a whole site or the company
 * (lane R5). They have no root cause: the card shows no category or confidence.
 */
const SUMMARY_KINDS: ReadonlySet<string> = new Set(['site_summary', 'company_summary']);

export function isSummaryInsight(insight: Pick<AiInsightDto, 'kind'>): boolean {
  return SUMMARY_KINDS.has(insight.kind);
}

/** Shown and not closed: open, or its action waits (`pending`). */
export function isLiveInsight(insight: Pick<AiInsightView, 'status'>): boolean {
  return (INSIGHT_LIVE_STATUSES as readonly string[]).includes(insight.status);
}

/** The status filter of the insights that still ask for attention. */
export const LIVE_INSIGHT_STATUS_FILTER = INSIGHT_LIVE_STATUSES.join(',');

/** An insight Explain can show instead of starting a conversation: live and current. */
export function isFreshInsight(insight: AiInsightView | undefined | null): boolean {
  return insight != null && isLiveInsight(insight) && !insight.stale;
}

/**
 * The insight a record's page shows: the open or pending one, else one
 * resolved within the last day. Others (done, rejected, dismissed, expired)
 * are not shown.
 */
/** A record shows a live insight, or one resolved within the recent window. */
export function isShownInsight(insight: AiInsightView, now: number = Date.now()): boolean {
  if (isLiveInsight(insight)) return true;
  return (
    insight.status === 'resolved' &&
    insight.resolvedAt != null &&
    now - Date.parse(insight.resolvedAt) <= RECENT_INSIGHT_MS
  );
}

export function pickShownInsight(
  insights: readonly AiInsightView[],
  now: number = Date.now(),
): AiInsightView | undefined {
  return insights.find(isLiveInsight) ?? insights.find((i) => isShownInsight(i, now));
}

/** Insight filter of an Explain context (an authorization: the insights covering the attempt). */
export function insightFilterFor(kind: AiRecordContextKind, id: string): InsightFilter {
  if (kind === 'authorization') return { authorizeAttemptIds: id };
  if (kind === 'reservation') return { reservationId: id };
  return kind === 'station' ? { stationId: id } : { sessionId: id };
}

/**
 * The authorization insights covering the refused attempts of an authorize
 * log page, by attempt id (`authorizeAttemptIds` filter, at most 100 ids;
 * each item lists the `matchedAttemptIds` it covers, grouped refusals
 * included).
 */
export function useAuthorizationInsights(
  attemptIds: readonly number[],
): Map<number, AiInsightView> {
  const ids = [...new Set(attemptIds)].sort((a, b) => a - b).slice(0, MAX_ATTEMPT_IDS);
  const { insights } = useInsights(
    { authorizeAttemptIds: ids.join(','), status: 'open', limit: MAX_ATTEMPT_IDS },
    ids.length > 0,
  );
  return useMemo(() => {
    const byAttempt = new Map<number, AiInsightView>();
    for (const insight of insights) {
      const covered = insight.matchedAttemptIds ?? [];
      for (const id of covered) if (!byAttempt.has(id)) byAttempt.set(id, insight);
    }
    return byAttempt;
  }, [insights]);
}

type InsightMutation<TBody> = UseMutationResult<unknown, unknown, { id: string; body?: TBody }>;

/** Refreshes every insight view and the insight's History after an action on it. */
function refreshInsight(queryClient: QueryClient, insightId: string): void {
  void queryClient.invalidateQueries({ queryKey: AI_INSIGHTS_KEY });
  void queryClient.invalidateQueries({ queryKey: ['audit', 'ai_insight', insightId] });
}

function useInsightMutation<TBody>(
  verb: 'regenerate' | 'dismiss' | 'feedback',
): InsightMutation<TBody> {
  const queryClient = useQueryClient();
  return useMutation<unknown, unknown, { id: string; body?: TBody }>({
    mutationFn: ({ id, body }) =>
      api.post(`/v1/ai/insights/${encodeURIComponent(id)}/${verb}`, body ?? {}),
    onSuccess: (_data, { id }) => {
      refreshInsight(queryClient, id);
    },
  });
}

export function useRegenerateInsight(): InsightMutation<never> {
  return useInsightMutation<never>('regenerate');
}

export function useDismissInsight(): InsightMutation<never> {
  return useInsightMutation<never>('dismiss');
}

/**
 * The body of a vote: a wrong vote can carry a short note. Readers of the
 * insight see it; a regeneration by its author sends it to the model as a
 * claim to check.
 */
interface InsightFeedbackBody {
  helpful: boolean;
  reason?: string | null;
}

/** Sets or changes the viewer's vote (one per user and insight). */
export function useInsightFeedback(): InsightMutation<InsightFeedbackBody> {
  return useInsightMutation<InsightFeedbackBody>('feedback');
}

/** Removes the viewer's vote. */
export function useClearInsightFeedback(): InsightMutation<never> {
  const queryClient = useQueryClient();
  return useMutation<unknown, unknown, { id: string; body?: never }>({
    mutationFn: ({ id }) => api.delete(`/v1/ai/insights/${encodeURIComponent(id)}/feedback`),
    onSuccess: (_data, { id }) => {
      refreshInsight(queryClient, id);
    },
  });
}

/** One wrong vote on an insight (`GET /v1/ai/insights/:id/feedback`). */
export interface InsightWrongVote {
  /** Null for a voter the viewer's site access does not let it see. */
  userId: string | null;
  userName: string | null;
  /** Operator text, shown as plain text; null when no note was given. */
  note: string | null;
  votedAt: string;
}

/** Rows per page of the Marked Wrong card. */
export const WRONG_VOTES_PAGE_SIZE = 10;

/** The wrong votes on an insight with their notes, newest first, one page. */
export function useInsightWrongVotes(
  insightId: string,
  page: number,
  enabled = true,
): {
  votes: InsightWrongVote[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const canRead = useHasPermission('aiInsights:read');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'wrong-votes', insightId, page],
    queryFn: () =>
      api.get<{ data: InsightWrongVote[]; total: number }>(
        `/v1/ai/insights/${encodeURIComponent(insightId)}/feedback?page=${String(page)}&limit=${String(WRONG_VOTES_PAGE_SIZE)}`,
      ),
    enabled: canRead && enabled,
    staleTime: INSIGHT_STALE_TIME_MS,
  });
  return {
    votes: data?.data ?? [],
    total: data?.total ?? 0,
    isLoading: canRead && enabled && isLoading,
    isError,
    refetch: () => {
      void refetch();
    },
  };
}

/** The nav count also polls, in case the event stream is down. */
const PENDING_ACTION_REFETCH_MS = 60_000;

/** Insights whose action waits for a decision, for the AI Insights nav count. */
export function usePendingActionCount(enabled: boolean): number {
  const canRead = useHasPermission('aiInsights:read');
  const { data } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'pending-action-count'],
    queryFn: () => api.get<InsightList>('/v1/ai/insights?status=pending&limit=1'),
    enabled: canRead && enabled,
    staleTime: INSIGHT_STALE_TIME_MS,
    refetchInterval: PENDING_ACTION_REFETCH_MS,
  });
  return data?.total ?? 0;
}

export type InsightActionDecision =
  | { verb: 'confirm'; insightId: string; argsHash: string }
  | { verb: 'reject'; insightId: string };

/**
 * Confirms (with the `argsHash` the user saw) or rejects the action an
 * insight carries. Answers the insight. Every insight view refreshes either
 * way (decided, stale, expired).
 */
export function useDecideInsightAction(): UseMutationResult<
  AiInsightView,
  unknown,
  InsightActionDecision
> {
  const queryClient = useQueryClient();
  return useMutation<AiInsightView, unknown, InsightActionDecision>({
    mutationFn: (d) =>
      api.post<AiInsightView>(
        `/v1/ai/insights/${encodeURIComponent(d.insightId)}/action/${d.verb}`,
        d.verb === 'confirm' ? { argsHash: d.argsHash } : {},
      ),
    onSettled: (_data, _err, d) => {
      refreshInsight(queryClient, d.insightId);
    },
  });
}

/** Votes by insight kind over the last days, in the user's sites (Settings quality summary). */
export function useInsightFeedbackSummary(): {
  days: number | null;
  rates: InsightFeedbackRate[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const canRead = useHasPermission('aiInsights:read');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'feedback-summary'],
    queryFn: () =>
      api.get<{ days: number; data: InsightFeedbackRate[] }>('/v1/ai/insights/feedback-summary'),
    enabled: canRead,
    staleTime: 60_000,
  });
  return {
    days: data?.days ?? null,
    rates: data?.data ?? [],
    isLoading: canRead && isLoading,
    isError,
    refetch: () => {
      void refetch();
    },
  };
}
