// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  /** Registers a trigger's value while it is rendered; returns the unregister call. */
  register: (value: string) => () => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (ctx == null) throw new Error('Tabs compound components must be used within <Tabs>');
  return ctx;
}

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * The tab shown: the requested one while a trigger offers it (or before any
 * trigger has rendered), else the first trigger. A tab kept in the URL can be
 * missing on another record (a protocol or permission tab, after Prev or Next):
 * the first tab shows instead and the URL keeps the request, so the tab comes
 * back on a record that has it.
 */
function shownTab(value: string, triggers: readonly string[]): string {
  if (triggers.length === 0 || triggers.includes(value)) return value;
  return triggers[0] ?? value;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ value, onValueChange, className, ...props }, ref) => {
    const [triggers, setTriggers] = useState<string[]>([]);
    const register = useCallback((trigger: string) => {
      setTriggers((prev) => (prev.includes(trigger) ? prev : [...prev, trigger]));
      return () => {
        setTriggers((prev) => prev.filter((v) => v !== trigger));
      };
    }, []);
    const shown = shownTab(value, triggers);
    const ctx = React.useMemo(
      () => ({ value: shown, onValueChange, register }),
      [shown, onValueChange, register],
    );
    return (
      <TabsContext.Provider value={ctx}>
        <div ref={ref} className={cn('w-full', className)} {...props} />
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

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
      const observer = new ResizeObserver(checkScroll);
      observer.observe(el);
      return () => {
        el.removeEventListener('scroll', checkScroll);
        observer.disconnect();
      };
    }, [checkScroll]);

    const scroll = (direction: 'left' | 'right') => {
      const el = scrollRef.current;
      if (el == null) return;
      el.scrollBy({ left: direction === 'left' ? -120 : 120, behavior: 'smooth' });
    };

    return (
      <div ref={ref} className={cn('relative max-w-full lg:max-w-[80%]', className)} {...props}>
        {canScrollLeft && (
          <button
            type="button"
            aria-label={t('common.scrollLeft')}
            onClick={() => {
              scroll('left');
            }}
            className="absolute left-0 top-0 z-10 flex h-full w-24 cursor-pointer items-center justify-start rounded-l-md bg-linear-to-r from-muted via-muted/60 to-transparent"
          >
            <ChevronLeft className="ml-1 h-4 w-4 text-muted-foreground" />
          </button>
        )}
        <div
          ref={scrollRef}
          role="tablist"
          className="inline-flex h-10 max-w-full items-center rounded-md bg-muted p-1 text-muted-foreground overflow-x-auto scrollbar-none"
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
            className="absolute right-0 top-0 z-10 flex h-full w-24 cursor-pointer items-center justify-end rounded-r-md bg-linear-to-l from-muted via-muted/60 to-transparent"
          >
            <ChevronRight className="mr-1 h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </div>
    );
  },
);
TabsList.displayName = 'TabsList';

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, ...props }, ref) => {
    const ctx = useTabsContext();
    const { register } = ctx;
    useEffect(() => register(value), [register, value]);
    const isActive = ctx.value === value;
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isActive}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          isActive
            ? 'bg-primary text-primary-foreground shadow-xs'
            : 'hover:bg-background/50 hover:text-foreground',
          className,
        )}
        onClick={() => {
          ctx.onValueChange(value);
        }}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  /**
   * Keeps the panel mounted (hidden) while another tab is active, so form
   * edits in it survive a tab switch. Pass it once the tab was opened, so
   * unvisited tabs still load nothing.
   */
  keepMounted?: boolean;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ value, className, keepMounted = false, ...props }, ref) => {
    const ctx = useTabsContext();
    const isActive = ctx.value === value;
    if (!isActive && !keepMounted) return null;
    return (
      <div
        ref={ref}
        role="tabpanel"
        hidden={!isActive}
        className={cn(
          'mt-2 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          className,
        )}
        {...props}
      />
    );
  },
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
export type { TabsProps };
