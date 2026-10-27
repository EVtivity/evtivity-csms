// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { LoadingLogo } from '@/components/loading-logo';

/** Loading state of a card or list: the animated logo, `role="status"`. */
export function LoadingState(): React.JSX.Element {
  return <LoadingLogo size="inline" />;
}

interface ErrorStateProps {
  /** Reloads the data; shows an outline Retry button. */
  onRetry?: (() => void) | undefined;
  /** Replaces the standard "Failed to load data" text. */
  message?: React.ReactNode;
  /** Replaces the standard Retry label. */
  retryLabel?: React.ReactNode;
  className?: string | undefined;
}

/** Load error of a card or list: the message and Retry, centered, `role="alert"`. */
export function ErrorState({
  onRetry,
  message,
  retryLabel,
  className,
}: ErrorStateProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="error-state"
      className={cn('flex flex-col items-center gap-3 py-6 text-center', className)}
    >
      <p className="text-sm text-destructive">{message ?? t('common.loadError')}</p>
      {onRetry != null && (
        <Button variant="outline" onClick={onRetry}>
          {retryLabel ?? t('common.retry')}
        </Button>
      )}
    </div>
  );
}

interface EmptyStateProps {
  children: React.ReactNode;
  className?: string | undefined;
}

/** Nothing to show in a card or list: centered muted text. */
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
