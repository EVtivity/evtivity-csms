// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ScrollFade } from './scroll-fade';

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
  ({ className, children, ...props }, ref) => (
    <ScrollFade
      ref={ref}
      surface="muted"
      className={cn('lg:max-w-[80%]', className)}
      innerProps={{ role: 'tablist' }}
      innerClassName="inline-flex h-10 items-center rounded-md bg-muted p-1 text-muted-foreground"
      {...props}
    >
      {children}
    </ScrollFade>
  ),
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
