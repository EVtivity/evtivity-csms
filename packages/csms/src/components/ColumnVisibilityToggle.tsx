// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  buildDefaultVisibility,
  type ColumnMeta,
  type ColumnVisibility,
} from '@/lib/column-visibility';

interface ColumnVisibilityToggleProps {
  tableKey: string;
  columns: ColumnMeta[];
  visibility: ColumnVisibility;
  onChange: (next: ColumnVisibility) => void;
}

export function ColumnVisibilityToggle({
  columns,
  visibility,
  onChange,
}: ColumnVisibilityToggleProps): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent): void {
      if (containerRef.current != null && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  function toggleColumn(key: string, checked: boolean): void {
    onChange({ ...visibility, [key]: checked });
  }

  function resetToDefaults(): void {
    const isMobile =
      typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches;
    onChange(buildDefaultVisibility(columns, isMobile));
  }

  const toggleable = columns.filter((c) => c.alwaysVisible !== true);

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={t('common.columns')}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="h-10 w-10"
      >
        <Columns3 className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border bg-popover p-3 shadow-md">
          <p className="mb-2 text-sm font-medium">{t('common.columns')}</p>
          <div className="flex flex-col gap-2">
            {toggleable.map((col) => {
              const id = `colvis-${col.key}`;
              const checked = visibility[col.key] !== false;
              return (
                <label
                  key={col.key}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onChange={(e) => {
                      toggleColumn(col.key, e.target.checked);
                    }}
                  />
                  <span>{t(col.label as never)}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-3 border-t pt-2">
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={resetToDefaults}
            >
              {t('common.reset')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
