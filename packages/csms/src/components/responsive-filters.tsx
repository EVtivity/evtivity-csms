// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ResponsiveFiltersProps {
  /** Primary filter selects shown inline on desktop */
  children: React.ReactNode;
  /** Extra filters shown only in the desktop "more filters" dropdown.
   *  On mobile/tablet these merge with children in the single dropdown. */
  moreFilters?: React.ReactNode;
  /** Number of active filters (shows badge on icon) */
  activeCount?: number;
}

/**
 * Responsive filter bar:
 * - Desktop (lg+): children inline + optional "more filters" dropdown icon
 * - Tablet/mobile (below lg): all filters behind a single Filter icon dropdown
 */
export function ResponsiveFilters({
  children,
  moreFilters,
  activeCount,
}: ResponsiveFiltersProps): React.JSX.Element {
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopMoreOpen, setDesktopMoreOpen] = useState(false);
  const mobileRef = useRef<HTMLDivElement>(null);
  const desktopMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileOpen && !desktopMoreOpen) return;
    function handleClick(e: MouseEvent): void {
      if (mobileOpen && mobileRef.current && !mobileRef.current.contains(e.target as Node)) {
        setMobileOpen(false);
      }
      if (
        desktopMoreOpen &&
        desktopMoreRef.current &&
        !desktopMoreRef.current.contains(e.target as Node)
      ) {
        setDesktopMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
    };
  }, [mobileOpen, desktopMoreOpen]);

  const showBadge = activeCount != null && activeCount > 0;

  return (
    <div className="ml-auto flex items-center">
      {/* Mobile/tablet: single filter icon with all filters in dropdown */}
      <div className="relative lg:hidden" ref={mobileRef}>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('common.moreFilters')}
          onClick={() => {
            setMobileOpen((v) => !v);
          }}
          className={showBadge ? 'border-primary text-primary' : ''}
        >
          <Filter className="h-4 w-4" />
          {showBadge && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
              {activeCount}
            </span>
          )}
        </Button>
        {mobileOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-3 rounded-lg border bg-popover p-3 shadow-md min-w-56 [&_select]:w-full">
            {children}
            {moreFilters}
          </div>
        )}
      </div>

      {/* Desktop: inline filters + optional "more filters" dropdown */}
      <div className="hidden lg:flex lg:flex-wrap lg:items-center lg:gap-4">
        {children}
        {moreFilters != null && (
          <div className="relative" ref={desktopMoreRef}>
            <Button
              variant="outline"
              size="sm"
              aria-label={t('common.moreFilters')}
              onClick={() => {
                setDesktopMoreOpen((v) => !v);
              }}
            >
              <Filter className="h-4 w-4" />
            </Button>
            {desktopMoreOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-3 rounded-lg border bg-popover p-3 shadow-md min-w-56 [&_select]:w-full">
                {moreFilters}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
