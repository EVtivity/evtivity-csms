// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingLogo } from '@/components/loading-logo';

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
 * empty text, or the chart. Without a state the chart shows as before.
 */
export function ChartBody({
  state,
  isEmpty,
  emptyText,
  children,
}: {
  state?: QueryState | undefined;
  isEmpty: boolean;
  emptyText: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (state?.isLoading === true) return <LoadingLogo size="inline" />;
  if (state?.isError === true) return <LoadErrorRetry onRetry={state.onRetry} />;
  if (isEmpty) return <p className="text-center text-sm text-muted-foreground">{emptyText}</p>;
  return <>{children}</>;
}
