// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SpeedDialAction {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

interface SpeedDialProps {
  trigger: React.ReactNode;
  triggerLabel?: string | undefined;
  actions: SpeedDialAction[];
  subMenu?: {
    key: string;
    backLabel: string;
    items: SpeedDialAction[];
  };
  collapsed?: boolean;
}

export function SpeedDial({
  trigger,
  triggerLabel,
  actions,
  subMenu,
  collapsed = false,
}: SpeedDialProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeSubMenu, setActiveSubMenu] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setActiveSubMenu(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current != null && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, close]);

  const displayItems =
    activeSubMenu != null && subMenu != null && subMenu.key === activeSubMenu
      ? subMenu.items
      : actions;

  const showBack = activeSubMenu != null;

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          className={cn(
            'absolute bottom-full left-0 right-0 mb-2 rounded-md border bg-popover p-1.5 shadow-md',
            collapsed && 'left-auto right-auto w-10',
          )}
        >
          {showBack && subMenu != null && (
            <button
              onClick={() => {
                setActiveSubMenu(null);
              }}
              title={collapsed ? subMenu.backLabel : undefined}
              className={cn(
                'flex w-full items-center rounded-sm text-sm font-medium text-muted-foreground',
                'transition-colors hover:bg-accent hover:text-accent-foreground',
                collapsed ? 'justify-center px-2 py-1.5' : 'gap-3 px-2 py-1.5',
                'animate-speed-dial-in',
              )}
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              {!collapsed && subMenu.backLabel}
            </button>
          )}
          <div className={cn('flex flex-col', activeSubMenu != null && 'max-h-40 overflow-y-auto')}>
            {displayItems.map((action, index) => (
              <button
                key={action.key}
                onClick={() => {
                  if (subMenu != null && action.key === subMenu.key) {
                    setActiveSubMenu(subMenu.key);
                  } else {
                    action.onClick();
                    close();
                  }
                }}
                title={collapsed ? action.label : undefined}
                className={cn(
                  'flex w-full items-center rounded-sm text-sm font-medium text-muted-foreground',
                  'transition-colors hover:bg-accent hover:text-accent-foreground',
                  collapsed ? 'justify-center px-2 py-2' : 'gap-2 px-2.5 py-2',
                  'animate-speed-dial-in',
                )}
                style={{ animationDelay: `${String(index * 50)}ms` }}
              >
                <span className="h-4 w-4 shrink-0 flex items-center justify-center">
                  {action.icon}
                </span>
                {!collapsed && action.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
          }
        }}
        className={cn(
          'flex w-full items-center rounded-md text-sm font-medium transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
        )}
      >
        {trigger}
        {!collapsed && triggerLabel != null && (
          <span className="truncate text-xs text-muted-foreground">{triggerLabel}</span>
        )}
      </button>
    </div>
  );
}
