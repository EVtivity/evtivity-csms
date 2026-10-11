// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  AiInsightDto,
  InsightFeedbackFilter,
  InsightFeedbackRate,
  InsightFeedbackSummary,
  InsightKind,
  InsightScope,
  InsightStatus,
  RootCauseCategory,
} from '@evtivity/lib/ai-insights';
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

/** An insight as the API sends it: the R0 DTO plus the primary-language text. */
export interface AiInsightView extends AiInsightDto {
  /** The canonical summary when `summary` is a translation or missing (Show original). */
  originalSummary?: string | null;
  /** With the `authorizeAttemptIds` filter: the listed attempts this insight covers. */
  matchedAttemptIds?: number[];
  /** OCPP identity of the station, for display. */
  stationName?: string | null;
  /** Name of the site, for display. */
  siteName?: string | null;
  /** Detail only: the same counts computed now (snapshot counts are in `scope`). */
  scopeNow?: InsightScope | null;
  /** Detail only: when `scopeNow` was computed. */
  scopeNowAt?: string | null;
  /** Detail only: the votes (one per user) and the viewer's own vote. */
  feedback?: InsightFeedbackSummary;
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
  status?: InsightStatus;
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

export function useInsightLanguage(): string {
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
      query.state.data?.data.some((i) => i.textStatus === 'pending' || i.status === 'pending')
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
      query.state.data?.textStatus === 'pending' || query.state.data?.status === 'pending'
        ? PENDING_TEXT_REFETCH_MS
        : false,
  });
  return { insight: data, isLoading: canRead && id != null && isLoading, isError, error };
}

/**
 * The scope counted now (`GET /v1/ai/insights/:id?scopeNow=true`), asked
 * only while `enabled` (the scope table is open). SQL only on the server.
 */
export function useInsightScopeNow(
  id: string,
  enabled: boolean,
): {
  scopeNow: InsightScope | null;
  scopeNowAt: string | null;
  isLoading: boolean;
} {
  const canRead = useHasPermission('aiInsights:read');
  const language = useInsightLanguage();
  const { data, isLoading } = useQuery({
    queryKey: [...AI_INSIGHTS_KEY, 'scope-now', id, language],
    queryFn: () =>
      api.get<AiInsightView>(
        `/v1/ai/insights/${encodeURIComponent(id)}?language=${encodeURIComponent(language)}&scopeNow=true`,
      ),
    enabled: canRead && enabled,
    staleTime: INSIGHT_STALE_TIME_MS,
    retry: false,
  });
  return {
    scopeNow: data?.scopeNow ?? null,
    scopeNowAt: data?.scopeNowAt ?? null,
    isLoading: canRead && enabled && isLoading,
  };
}

/**
 * Kinds a background worker writes about a whole site or the company
 * (lane R5). They have no root cause: the card shows no category or confidence.
 */
const SUMMARY_KINDS: ReadonlySet<string> = new Set(['site_summary', 'company_summary']);

export function isSummaryInsight(insight: Pick<AiInsightDto, 'kind'>): boolean {
  return SUMMARY_KINDS.has(insight.kind);
}

/** An insight Explain can show instead of starting a conversation: active and current. */
export function isFreshInsight(insight: AiInsightView | undefined | null): boolean {
  return insight != null && insight.status === 'active' && !insight.stale;
}

/**
 * The insight a record's page shows: the active or analyzing one, else one
 * resolved within the last day. Others (skipped, failed, dismissed,
 * superseded) are not shown.
 */
export function pickShownInsight(
  insights: readonly AiInsightView[],
  now: number = Date.now(),
): AiInsightView | undefined {
  const open = insights.find((i) => i.status === 'active' || i.status === 'pending');
  if (open != null) return open;
  return insights.find(
    (i) =>
      i.status === 'resolved' &&
      i.resolvedAt != null &&
      now - Date.parse(i.resolvedAt) <= RECENT_INSIGHT_MS,
  );
}

/** Insight filter of an Explain context, for the records that have one. */
export function insightFilterFor(
  kind: 'station' | 'session' | 'reservation',
  id: string,
): InsightFilter {
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
    { authorizeAttemptIds: ids.join(','), status: 'active', limit: MAX_ATTEMPT_IDS },
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

export type InsightMutation<TBody> = UseMutationResult<
  unknown,
  unknown,
  { id: string; body?: TBody }
>;

function useInsightMutation<TBody>(
  verb: 'regenerate' | 'dismiss' | 'feedback',
): InsightMutation<TBody> {
  const queryClient = useQueryClient();
  return useMutation<unknown, unknown, { id: string; body?: TBody }>({
    mutationFn: ({ id, body }) =>
      api.post(`/v1/ai/insights/${encodeURIComponent(id)}/${verb}`, body ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AI_INSIGHTS_KEY });
    },
  });
}

export function useRegenerateInsight(): InsightMutation<never> {
  return useInsightMutation<never>('regenerate');
}

export function useDismissInsight(): InsightMutation<never> {
  return useInsightMutation<never>('dismiss');
}

/** The body of a vote: a wrong vote can carry a short note (stored only, never sent to a model). */
export interface InsightFeedbackBody {
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AI_INSIGHTS_KEY });
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
