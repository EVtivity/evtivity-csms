// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { presetRange } from '@/lib/date-range';

interface DateRangeControlProps {
  days: number;
  from: string | null;
  to: string | null;
  onPresetChange: (days: number) => void;
  onCustomChange: (from: string, to: string) => void;
  /** Earliest selectable date (e.g. oldest snapshot). */
  minDate?: string | undefined;
  /** Latest selectable date (defaults to the derived range's end). */
  maxDate?: string | undefined;
}

const PRESETS = [
  { days: 7, key: 'dashboard.last7d' as const },
  { days: 14, key: 'dashboard.last14d' as const },
  { days: 21, key: 'dashboard.last21d' as const },
  { days: 30, key: 'dashboard.last30d' as const },
  { days: 60, key: 'dashboard.last60d' as const },
];

export function DateRangeControl({
  days,
  from,
  to,
  onPresetChange,
  onCustomChange,
  minDate,
  maxDate,
}: DateRangeControlProps): React.JSX.Element {
  const { t } = useTranslation();
  const isCustom = from != null && to != null;

  // Presets display their implied dates so the inputs are never blank; the
  // range only becomes custom once the user edits a date.
  const derived = presetRange(days);
  const displayFrom = from ?? derived.from;
  const displayTo = to ?? derived.to;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Date range"
        value={isCustom ? '' : String(days)}
        onChange={(e) => {
          if (e.target.value) {
            onPresetChange(Number(e.target.value));
          }
        }}
        className="h-8 w-auto px-2 pr-8 text-xs"
      >
        {isCustom && <option value="">{t('dashboard.custom')}</option>}
        {PRESETS.map((p) => (
          <option key={p.days} value={String(p.days)}>
            {t(p.key)}
          </option>
        ))}
      </Select>
      <div className="flex items-center gap-2">
        <input
          type="date"
          aria-label="Start date"
          value={displayFrom}
          min={minDate}
          // max stops the user from picking a start that comes after the
          // end. Without it the chart endpoints (energy-history,
          // session-history, revenue-history, peak-usage, utilization) saw
          // diffDays < 1 in parseDateRange and silently fell back to a
          // 7-day window, so the picker and the rendered data disagreed.
          max={displayTo}
          onChange={(e) => {
            if (e.target.value) {
              onCustomChange(e.target.value, displayTo);
            }
          }}
          className="h-8 w-[130px] rounded-md border bg-background px-1.5 text-xs"
        />
        <span className="text-xs text-muted-foreground">{t('dashboard.to')}</span>
        <input
          type="date"
          aria-label="End date"
          value={displayTo}
          min={displayFrom}
          max={maxDate}
          onChange={(e) => {
            if (e.target.value) {
              onCustomChange(displayFrom, e.target.value);
            }
          }}
          className="h-8 w-[130px] rounded-md border bg-background px-1.5 text-xs"
        />
      </div>
    </div>
  );
}
