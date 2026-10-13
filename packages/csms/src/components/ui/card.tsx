// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { Link } from 'react-router';
import type { LinkProps } from 'react-router';
import { cn } from '@/lib/utils';

/**
 * `warning`: a card that asks for action (missing configuration), same layout as any card.
 * `ai`: a card that holds AI output (the dashboard Active Insights), on a soft brand gradient.
 */
export type CardTone = 'default' | 'warning' | 'ai';

const CARD_TONES: Record<CardTone, string> = {
  default: '',
  warning: 'border-warning/60',
  ai: 'border-primary/30 bg-linear-to-br from-primary/10 via-card to-info/10',
};

/** A thin left accent in a tone color, for a card that marks its kind (an automatic insight). */
export type CardAccent = 'info' | 'warning' | 'destructive' | 'success' | 'muted';

const CARD_ACCENTS: Record<CardAccent, string> = {
  info: 'border-l-4 border-l-info',
  warning: 'border-l-4 border-l-warning',
  destructive: 'border-l-4 border-l-destructive',
  success: 'border-l-4 border-l-success',
  muted: 'border-l-4 border-l-muted-foreground',
};

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  accent?: CardAccent;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, tone = 'default', accent, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-xs',
        CARD_TONES[tone],
        accent != null && CARD_ACCENTS[accent],
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

/** `stat`: the dashboard stat card header (title left, icon or badge right). */
export type CardHeaderVariant = 'default' | 'stat';

const CARD_HEADER_VARIANTS: Record<CardHeaderVariant, string> = {
  default: 'flex flex-col gap-1.5 p-6',
  stat: 'flex flex-row items-center justify-between gap-2 space-y-0 p-6 pb-2',
};

interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardHeaderVariant;
}

const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div ref={ref} className={cn(CARD_HEADER_VARIANTS[variant], className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CARD_TITLE_VARIANTS: Record<CardHeaderVariant, string> = {
  default: 'text-2xl font-semibold leading-none tracking-tight',
  stat: 'flex items-center gap-1 text-sm font-medium leading-none tracking-tight',
};

interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  variant?: CardHeaderVariant;
}

const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <h3 ref={ref} className={cn(CARD_TITLE_VARIANTS[variant], className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

/** `list`: no side or bottom padding, for a `CardList` whose rows run edge to edge. */
export type CardContentVariant = 'default' | 'list';

const CARD_CONTENT_VARIANTS: Record<CardContentVariant, string> = {
  default: 'p-6 pt-0',
  list: 'p-0',
};

interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardContentVariant;
}

const CardContent = React.forwardRef<HTMLDivElement, CardContentProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div ref={ref} className={cn(CARD_CONTENT_VARIANTS[variant], className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

/** `divided`: a border above and the content on the right ("View all"). */
export type CardFooterVariant = 'default' | 'divided';

const CARD_FOOTER_VARIANTS: Record<CardFooterVariant, string> = {
  default: 'flex items-center p-6 pt-0',
  divided: 'flex items-center justify-end border-t px-6 py-2',
};

interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardFooterVariant;
}

const CardFooter = React.forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div ref={ref} className={cn(CARD_FOOTER_VARIANTS[variant], className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

/** Rows inside a card (`CardContent variant="list"`), divided by a border. */
const CardList = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
  ({ className, ...props }, ref) => (
    <ul ref={ref} className={cn('divide-y divide-border border-t', className)} {...props} />
  ),
);
CardList.displayName = 'CardList';

const CARD_LIST_ROW = 'flex items-start gap-3 px-6 py-3';

/** A row of a `CardList` that is not a link. */
const CardListItem = React.forwardRef<HTMLLIElement, React.LiHTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} className={cn(CARD_LIST_ROW, className)} {...props} />
  ),
);
CardListItem.displayName = 'CardListItem';

/** A row of a `CardList` that opens a page: the whole row is the link. */
function CardListLink({ className, ...props }: LinkProps): React.JSX.Element {
  return (
    <li>
      <Link
        className={cn(
          CARD_LIST_ROW,
          'transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          className,
        )}
        {...props}
      />
    </li>
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  CardList,
  CardListItem,
  CardListLink,
};
