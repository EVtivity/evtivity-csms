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
  /** The current choice of a submenu: shown with `aria-pressed`. */
  selected?: boolean | undefined;
}

export interface SpeedDialSubMenu {
  /** The key of the action that opens it. */
  key: string;
  backLabel: string;
  items: SpeedDialAction[];
}

interface SpeedDialProps {
  trigger: React.ReactNode;
  triggerLabel?: string | undefined;
  actions: SpeedDialAction[];
  subMenus?: SpeedDialSubMenu[];
  collapsed?: boolean;
}

export function SpeedDial({
  trigger,
  triggerLabel,
  actions,
  subMenus = [],
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

  const subMenu = subMenus.find((menu) => menu.key === activeSubMenu);
  const displayItems = subMenu != null ? subMenu.items : actions;

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          className={cn(
            'absolute bottom-full left-0 right-0 mb-2 rounded-md border bg-popover p-1.5 shadow-md',
            collapsed && 'left-auto right-auto w-10',
          )}
        >
          {subMenu != null && (
            <button
              type="button"
              aria-label={subMenu.backLabel}
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
          <div className={cn('flex flex-col', subMenu != null && 'max-h-40 overflow-y-auto')}>
            {displayItems.map((action, index) => (
              <button
                type="button"
                key={action.key}
                aria-label={action.label}
                aria-pressed={action.selected}
                onClick={() => {
                  if (subMenu == null && subMenus.some((menu) => menu.key === action.key)) {
                    setActiveSubMenu(action.key);
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
        type="button"
        aria-expanded={open}
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
