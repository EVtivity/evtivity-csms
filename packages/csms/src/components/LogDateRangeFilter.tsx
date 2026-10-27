// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { UrlDateRange } from '@/hooks/use-url-date-range';

interface LogDateRangeFilterProps {
  range: Pick<UrlDateRange, 'from' | 'to' | 'setFrom' | 'setTo' | 'clear'>;
  /** Called after any change, such as to go back to page 1. */
  onChange?: () => void;
}

/**
 * From and To day inputs of a log list, as two filter cells (it fits a filter
 * grid and the FilterPopover). To cannot be before From; Clear Dates empties
 * both.
 */
export function LogDateRangeFilter({
  range,
  onChange,
}: LogDateRangeFilterProps): React.JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const fromId = `${id}-from`;
  const toId = `${id}-to`;
  const hasRange = range.from !== '' || range.to !== '';

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={fromId} className="leading-6">
          {t('common.from')}
        </Label>
        <Input
          id={fromId}
          type="date"
          aria-label={t('common.from')}
          value={range.from}
          max={range.to !== '' ? range.to : undefined}
          onChange={(e) => {
            range.setFrom(e.target.value);
            onChange?.();
          }}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={toId} className="leading-6">
            {t('common.to')}
          </Label>
          {hasRange && (
            <Button
              type="button"
              variant="link"
              size="inline"
              onClick={() => {
                range.clear();
                onChange?.();
              }}
            >
              {t('common.clearDates')}
            </Button>
          )}
        </div>
        <Input
          id={toId}
          type="date"
          aria-label={t('common.to')}
          value={range.to}
          min={range.from !== '' ? range.from : undefined}
          onChange={(e) => {
            range.setTo(e.target.value);
            onChange?.();
          }}
        />
      </div>
    </>
  );
}
