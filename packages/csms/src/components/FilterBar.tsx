// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FilterPopoverProps {
  children: React.ReactNode;
  activeCount?: number;
  className?: string;
  onClearAll?: () => void;
}

/**
 * Filter icon button that opens a popover with the provided filters stacked.
 * Use inside a mobile-only flex row alongside the SearchInput and the
 * ColumnVisibilityToggle. Pair with a desktop grid layout (hidden md:flex)
 * that renders the same filters with visible labels.
 */
export function FilterPopover({
  children,
  activeCount = 0,
  className,
  onClearAll,
}: FilterPopoverProps): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent): void {
      if (ref.current != null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => {
      document.removeEventListener('mousedown', handle);
    };
  }, [open]);

  const showBadge = activeCount > 0;

  return (
    <div className={cn('relative', className)} ref={ref}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={t('common.filters')}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className={cn('relative h-10 w-10', showBadge && 'border-primary text-primary')}
      >
        <Filter className="h-4 w-4" />
        {showBadge && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
            {activeCount}
          </span>
        )}
      </Button>
      {open && (
        <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-4rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border bg-popover p-4 shadow-lg [&_select]:w-full">
          {onClearAll != null && (
            <button
              type="button"
              className="absolute right-4 top-4 z-10 text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              disabled={activeCount === 0}
              onClick={() => {
                onClearAll();
                setOpen(false);
              }}
            >
              {t('common.clearAllFilters')}
            </button>
          )}
          {children}
        </div>
      )}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          aria-hidden
          onClick={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
