// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface ScrollSnapItem {
  id: string;
  content: React.ReactNode;
}

interface Layout {
  /** Distance from one item to the next (item width plus the gap). */
  step: number;
  /** Items fully in view at once. */
  visible: number;
}

function measure(el: HTMLDivElement): Layout {
  const children = el.children;
  const first = children[0] as HTMLElement | undefined;
  const second = children[1] as HTMLElement | undefined;
  const step =
    first != null && second != null
      ? second.offsetLeft - first.offsetLeft
      : (first?.offsetWidth ?? el.clientWidth);
  if (step <= 0) return { step: 0, visible: 1 };
  return { step, visible: Math.max(1, Math.round(el.clientWidth / step)) };
}

/**
 * A row of items that scrolls sideways with snap points and a dot indicator
 * under it (dashboard Revenue cards, Active insights). `itemClassName` sets
 * the item width: `w-full` (default) shows one item per view; a fraction
 * such as `sm:w-[calc((100%-1rem)/2)] lg:w-[calc((100%-2rem)/3)]` with
 * `gap="gap-4"` shows several. There is one dot per scroll position (items
 * minus the ones in view, plus one), the active one wide; a dot scrolls to
 * its position. No dots when everything fits.
 */
export function ScrollSnapRow({
  items,
  itemClassName = 'w-full',
  gap,
  className,
  testId,
}: {
  items: ScrollSnapItem[];
  itemClassName?: string;
  /** Space between items, a Tailwind gap class (none for full-width pages). */
  gap?: string;
  className?: string;
  testId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [layout, setLayout] = useState<Layout>({ step: 0, visible: 1 });

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (el == null) return;
    const next = measure(el);
    setLayout((prev) => (prev.step === next.step && prev.visible === next.visible ? prev : next));
    setActive(next.step > 0 ? Math.round(el.scrollLeft / next.step) : 0);
  }, []);

  useEffect(() => {
    update();
    const el = scrollRef.current;
    if (el == null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [update, items.length]);

  function goTo(index: number): void {
    const el = scrollRef.current;
    if (el == null) return;
    el.scrollTo({ left: index * (layout.step || el.clientWidth), behavior: 'smooth' });
  }

  const positions = Math.max(1, items.length - layout.visible + 1);
  const current = Math.min(active, positions - 1);

  return (
    <div className={cn('space-y-2', className)} data-testid={testId}>
      <div
        ref={scrollRef}
        onScroll={update}
        className={cn(
          'flex snap-x snap-mandatory overflow-x-auto scroll-smooth [-ms-overflow-style:none] scrollbar-none [&::-webkit-scrollbar]:hidden',
          gap,
        )}
      >
        {items.map((item) => (
          <div key={item.id} className={cn('min-w-0 shrink-0 snap-start', itemClassName)}>
            {item.content}
          </div>
        ))}
      </div>
      {positions > 1 && (
        <div className="flex justify-center gap-1.5" data-testid="scroll-snap-dots">
          {Array.from({ length: positions }, (_, index) => (
            <button
              key={index}
              type="button"
              aria-label={t('dashboard.showPage', { page: index + 1, total: positions })}
              aria-current={index === current ? 'true' : undefined}
              onClick={() => {
                goTo(index);
              }}
              className={cn(
                'h-1.5 rounded-full transition-all',
                index === current ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/40',
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
