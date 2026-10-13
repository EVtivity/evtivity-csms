// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The surface behind the row, so the fade blends into it. */
type FadeSurface = 'muted' | 'background';

const FADE: Record<FadeSurface, { left: string; right: string; icon: string }> = {
  muted: {
    left: 'bg-linear-to-r from-muted via-muted/60 to-transparent rounded-l-md',
    right: 'bg-linear-to-l from-muted via-muted/60 to-transparent rounded-r-md',
    icon: 'text-muted-foreground',
  },
  background: {
    left: 'bg-linear-to-r from-background via-background/60 to-transparent',
    right: 'bg-linear-to-l from-background via-background/60 to-transparent',
    icon: 'text-foreground',
  },
};

/**
 * A single line that scrolls sideways when it does not fit: the edge it can
 * scroll toward fades out under a chevron button that scrolls it. The tab
 * control and long detail page titles use it.
 */
export const ScrollFade = React.forwardRef<
  HTMLDivElement,
  {
    surface?: FadeSurface;
    className?: string;
    /** Classes and attributes of the scrolling line itself. */
    innerClassName?: string;
    innerProps?: React.HTMLAttributes<HTMLDivElement>;
    children: React.ReactNode;
  } & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>
>(({ surface = 'muted', className, innerClassName, innerProps, children, ...props }, ref) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const fade = FADE[surface];

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el == null) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (el == null) return undefined;
    el.addEventListener('scroll', checkScroll, { passive: true });
    // Older browsers and test environments have no ResizeObserver: the scroll listener still works.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(checkScroll);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      observer?.disconnect();
    };
  }, [checkScroll]);

  const scroll = (direction: 'left' | 'right'): void => {
    scrollRef.current?.scrollBy({ left: direction === 'left' ? -120 : 120, behavior: 'smooth' });
  };

  return (
    <div ref={ref} className={cn('relative min-w-0 max-w-full', className)} {...props}>
      {canScrollLeft && (
        <button
          type="button"
          aria-label={t('common.scrollLeft')}
          onClick={() => {
            scroll('left');
          }}
          className={cn(
            'absolute left-0 top-0 z-10 flex h-full w-24 cursor-pointer items-center justify-start',
            fade.left,
          )}
        >
          <ChevronLeft className={cn('ml-1 h-4 w-4', fade.icon)} />
        </button>
      )}
      <div
        ref={scrollRef}
        {...innerProps}
        className={cn('max-w-full overflow-x-auto scrollbar-none', innerClassName)}
      >
        {children}
      </div>
      {canScrollRight && (
        <button
          type="button"
          aria-label={t('common.scrollRight')}
          onClick={() => {
            scroll('right');
          }}
          className={cn(
            'absolute right-0 top-0 z-10 flex h-full w-24 cursor-pointer items-center justify-end',
            fade.right,
          )}
        >
          <ChevronRight className={cn('mr-1 h-4 w-4', fade.icon)} />
        </button>
      )}
    </div>
  );
});
ScrollFade.displayName = 'ScrollFade';
