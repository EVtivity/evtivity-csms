// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';

interface DateRangeControlProps {
  days: number;
  from: string | null;
  to: string | null;
  onPresetChange: (days: number) => void;
  onCustomChange: (from: string, to: string) => void;
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
}: DateRangeControlProps): React.JSX.Element {
  const { t } = useTranslation();
  const isCustom = from != null && to != null;

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
          value={from ?? ''}
          onChange={(e) => {
            if (e.target.value && to) {
              onCustomChange(e.target.value, to);
            } else if (e.target.value) {
              const toDate = new Date().toISOString().split('T')[0];
              if (toDate) onCustomChange(e.target.value, toDate);
            }
          }}
          className="h-8 w-[130px] rounded-md border bg-background px-1.5 text-xs"
        />
        <span className="text-xs text-muted-foreground">{t('dashboard.to')}</span>
        <input
          type="date"
          aria-label="End date"
          value={to ?? ''}
          onChange={(e) => {
            if (from && e.target.value) {
              onCustomChange(from, e.target.value);
            }
          }}
          className="h-8 w-[130px] rounded-md border bg-background px-1.5 text-xs"
        />
      </div>
    </div>
  );
}
