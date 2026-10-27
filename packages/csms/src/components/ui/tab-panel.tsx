// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type CardAccent,
  type CardTone,
} from '@/components/ui/card';
import { contentState } from '@/components/ui/content-state';

const tabPanelBodyVariants = cva('', {
  variants: {
    body: {
      /** Standard card padding (`p-6 pt-0`). */
      padded: 'p-6 pt-0',
      /** No padding: a table or list that runs edge to edge. */
      flush: 'p-0',
    },
  },
  defaultVariants: { body: 'padded' },
});

export interface TabPanelProps
  extends
    Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof tabPanelBodyVariants> {
  /**
   * The card title. The first card of a detail page tab shows the tab label;
   * later cards in the same tab keep their own titles.
   */
  title?: React.ReactNode;
  /** One line of explanatory text under the title. */
  description?: React.ReactNode;
  /** Buttons or filters on the right of the header (under the title on phones). */
  actions?: React.ReactNode;
  /**
   * `stacked` (default): the actions go under the title on phones. `inline`: one
   * compact control stays on the right of the title at every width.
   */
  actionsPosition?: 'stacked' | 'inline' | undefined;
  /** Extra classes for the body (such as `space-y-4`). */
  bodyClassName?: string | undefined;
  /** Shows the loading state instead of the body. */
  isLoading?: boolean | undefined;
  /** Shows the load error and Retry instead of the body. */
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  errorMessage?: React.ReactNode;
  /** Shows `emptyMessage` instead of the body. */
  isEmpty?: boolean | undefined;
  emptyMessage?: React.ReactNode;
  tone?: CardTone | undefined;
  accent?: CardAccent | undefined;
}

/**
 * The container of a detail page tab: a card whose header holds the title, an
 * optional description and actions, and whose body shows the standard loading,
 * error and empty states.
 */
const TabPanel = React.forwardRef<HTMLDivElement, TabPanelProps>(
  (
    {
      title,
      description,
      actions,
      actionsPosition = 'stacked',
      body,
      bodyClassName,
      isLoading,
      isError,
      onRetry,
      errorMessage,
      isEmpty,
      emptyMessage,
      tone,
      accent,
      children,
      className,
      ...props
    },
    ref,
  ) => {
    const state = contentState({
      isLoading: isLoading === true,
      isError: isError === true,
      onRetry,
      errorMessage,
      isEmpty: isEmpty === true,
      emptyMessage,
    });
    const hasHeader = title != null || description != null || actions != null;
    return (
      <Card
        ref={ref}
        data-testid="tab-panel"
        tone={tone ?? 'default'}
        {...(accent != null ? { accent } : {})}
        className={className}
        {...props}
      >
        {hasHeader && (
          <CardHeader
            className={
              actionsPosition === 'inline'
                ? 'flex flex-row items-center justify-between gap-3'
                : 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'
            }
          >
            <div className="min-w-0 space-y-1.5">
              {title != null && <CardTitle>{title}</CardTitle>}
              {description != null && <CardDescription>{description}</CardDescription>}
            </div>
            {actions != null && (
              <div
                className={cn(
                  'flex flex-wrap items-center gap-2',
                  actionsPosition === 'inline' && 'shrink-0',
                )}
              >
                {actions}
              </div>
            )}
          </CardHeader>
        )}
        <CardContent
          variant="default"
          className={cn(
            tabPanelBodyVariants({ body: state != null ? 'padded' : body }),
            !hasHeader && (state != null || body !== 'flush') && 'pt-6',
            state == null && bodyClassName,
          )}
        >
          {state ?? children}
        </CardContent>
      </Card>
    );
  },
);
TabPanel.displayName = 'TabPanel';

export { TabPanel, tabPanelBodyVariants };
