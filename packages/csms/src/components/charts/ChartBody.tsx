// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingLogo } from '@/components/loading-logo';
import { EmptyState } from '@/components/ui/content-state';

/** The plot height of a dashboard chart card; every state of the card body keeps it. */
export const CHART_HEIGHT = 300;

/** The state of the query behind a card: loading, failed (with a retry), or loaded. */
export interface QueryState {
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/** The query state of a TanStack query, for a card. */
export function queryState(query: {
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
}): QueryState {
  return {
    isLoading: query.isLoading,
    isError: query.isError,
    onRetry: () => {
      void query.refetch();
    },
  };
}

/** The load error of a card, with a Retry button. */
export function LoadErrorRetry({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-destructive">{t('common.loadError')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

/**
 * The body of a chart card: the loading mark, the load error with Retry, the
 * empty chart or text, or the chart. Every state but the chart keeps the chart
 * height (`height`, default `CHART_HEIGHT`), so a card without data is as tall
 * as the cards next to it. Without a state the chart shows as before.
 */
export function ChartBody({
  state,
  isEmpty,
  emptyText,
  emptyChart,
  height = CHART_HEIGHT,
  children,
}: {
  state?: QueryState | undefined;
  isEmpty: boolean;
  emptyText: string;
  /** Drawn instead of the empty text, such as an empty donut ring (`EmptyDonut`). */
  emptyChart?: React.ReactNode;
  height?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  if (state?.isLoading === true) {
    return (
      <ChartPlaceholder height={height}>
        <LoadingLogo size="inline" />
      </ChartPlaceholder>
    );
  }
  if (state?.isError === true) {
    return (
      <ChartPlaceholder height={height}>
        <LoadErrorRetry onRetry={state.onRetry} />
      </ChartPlaceholder>
    );
  }
  if (isEmpty) {
    return (
      <ChartPlaceholder height={height}>
        {emptyChart ?? <EmptyState className="py-0">{emptyText}</EmptyState>}
      </ChartPlaceholder>
    );
  }
  return <>{children}</>;
}

/** A centered area as tall as the chart it stands in for. */
export function ChartPlaceholder({
  height = CHART_HEIGHT,
  children,
}: {
  height?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-testid="chart-placeholder"
      className="flex flex-col items-center justify-center"
      style={{ minHeight: height }}
    >
      {children}
    </div>
  );
}
