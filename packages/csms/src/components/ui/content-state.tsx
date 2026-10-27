// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { LoadingLogo } from '@/components/loading-logo';

/** Loading state of a card body or table: the animated logo, `role="status"`. */
export function LoadingState(): React.JSX.Element {
  return <LoadingLogo size="inline" />;
}

interface ErrorStateProps {
  /** Reloads the data; shows an outline Retry button. */
  onRetry?: (() => void) | undefined;
  /** Replaces the standard "Failed to load data" text. */
  message?: React.ReactNode;
  className?: string | undefined;
}

/** Load error of a card body or table: the message and Retry, centered, `role="alert"`. */
export function ErrorState({ onRetry, message, className }: ErrorStateProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="error-state"
      className={cn('flex flex-col items-center gap-3 py-6 text-center', className)}
    >
      <p className="text-sm text-destructive">{message ?? t('common.loadError')}</p>
      {onRetry != null && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

interface EmptyStateProps {
  children: React.ReactNode;
  className?: string;
}

/** Nothing to show in a card body or table: centered muted text. */
export function EmptyState({ children, className }: EmptyStateProps): React.JSX.Element {
  return (
    <p
      data-testid="empty-state"
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
    >
      {children}
    </p>
  );
}

interface TableStateRowProps {
  colSpan: number;
  children: React.ReactNode;
}

/** A table body row that spans every column and holds one of the states above. */
export function TableStateRow({ colSpan, children }: TableStateRowProps): React.JSX.Element {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan}>{children}</TableCell>
    </TableRow>
  );
}

export interface ContentStateOptions {
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: (() => void) | undefined;
  errorMessage?: React.ReactNode;
  isEmpty?: boolean;
  emptyMessage?: React.ReactNode;
}

/**
 * The state to show instead of the content, in order: loading, error, empty.
 * Returns null when the content itself should render.
 */
export function contentState({
  isLoading = false,
  isError = false,
  onRetry,
  errorMessage,
  isEmpty = false,
  emptyMessage,
}: ContentStateOptions): React.JSX.Element | null {
  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState onRetry={onRetry} message={errorMessage} />;
  if (isEmpty && emptyMessage != null) return <EmptyState>{emptyMessage}</EmptyState>;
  return null;
}
