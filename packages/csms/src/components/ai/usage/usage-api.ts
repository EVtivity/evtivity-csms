// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import type { AiMyUsageDto, AiSiteUsageDto, AiUsageDto } from '@evtivity/lib/ai-usage';
import { AI_PRICE_CURRENCY } from '@evtivity/lib/pricing-engine';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatMajorAmount } from '@/lib/formatting';

/**
 * AI usage in the CSMS: the Settings > AI > Usage tab, the site
 * card and the panel footer. Budgets are tokens (decision D10); cost is
 * micro-USD and shown only when the company currency is USD.
 */

/** Root of every usage query; the `ai.usage.threshold` SSE event invalidates it. */
export const AI_USAGE_KEY = ['ai', 'usage'] as const;
export const AI_MY_USAGE_KEY = [...AI_USAGE_KEY, 'me'] as const;

const USAGE_STALE_TIME_MS = 60_000;

export function useCompanyAiUsage(month: string | null): {
  data: AiUsageDto | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const canRead = useHasPermission('aiUsage:read');
  const { data, isLoading, isError } = useQuery({
    queryKey: [...AI_USAGE_KEY, 'company', month],
    queryFn: () =>
      api.get<AiUsageDto>(
        month != null ? `/v1/ai/usage?month=${encodeURIComponent(month)}` : '/v1/ai/usage',
      ),
    enabled: canRead,
    staleTime: USAGE_STALE_TIME_MS,
  });
  return { data, isLoading: canRead && isLoading, isError };
}

export function useSiteAiUsage(
  siteId: string,
  enabled: boolean,
): {
  data: AiSiteUsageDto | undefined;
  isError: boolean;
} {
  const canRead = useHasPermission('aiUsage:read');
  const { data, isError } = useQuery({
    queryKey: [...AI_USAGE_KEY, 'site', siteId],
    queryFn: () => api.get<AiSiteUsageDto>(`/v1/ai/usage/sites/${encodeURIComponent(siteId)}`),
    enabled: canRead && enabled && siteId !== '',
    staleTime: USAGE_STALE_TIME_MS,
    retry: false,
  });
  return { data, isError };
}

export function useMyAiUsage(enabled: boolean): AiMyUsageDto | undefined {
  const canRead = useHasPermission('aiAssistant:read');
  const { data } = useQuery({
    queryKey: AI_MY_USAGE_KEY,
    queryFn: () => api.get<AiMyUsageDto>('/v1/users/me/ai-usage'),
    enabled: canRead && enabled,
    staleTime: USAGE_STALE_TIME_MS,
    retry: false,
  });
  return data;
}

/**
 * A cost formatter when the company currency is USD (provider prices are in
 * USD and no exchange rate is kept, `currency.md`), else null: show tokens only.
 */
export function useAiCostFormatter(): ((costMicros: number) => string) | null {
  const { currency } = useCompanyCurrency();
  if (currency !== AI_PRICE_CURRENCY) return null;
  return (costMicros) => formatMajorAmount(String(costMicros / 1_000_000), AI_PRICE_CURRENCY);
}
