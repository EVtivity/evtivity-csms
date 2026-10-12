// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { uiLocale } from '@/lib/formatting';

/** Months a picker offers by default: the latest and the 23 before it. */
const DEFAULT_MONTH_COUNT = 24;

/** `YYYY-MM` of a date, in the browser's timezone. */
export function monthOf(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** `count` months, newest first, ending at `latest` (`YYYY-MM`); `value` is kept when outside. */
export function monthOptions(latest: string, count: number, value?: string): string[] {
  const [year, month] = latest.split('-').map(Number);
  if (year == null || month == null || Number.isNaN(year) || Number.isNaN(month)) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(`${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  if (value != null && value !== '' && !out.includes(value)) {
    out.push(value);
    out.sort().reverse();
  }
  return out;
}

/** "October 2026" in the UI language. */
export function monthLabel(month: string, locale: string = uiLocale()): string {
  const [year, m] = month.split('-').map(Number);
  if (year == null || m == null) return month;
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, m - 1, 1)));
}

interface MonthPickerProps {
  id?: string;
  /** The picked month, `YYYY-MM`. */
  value: string;
  onChange: (month: string) => void;
  /** The newest month offered (`YYYY-MM`); defaults to the current month. */
  latest?: string;
  /** How many months are offered, newest first. */
  count?: number;
  className?: string;
  'aria-label'?: string;
}

/**
 * The shared month picker: the shared `Select` with one option per month,
 * labelled in the UI language. Every browser shows the same control (the
 * native month input has no picker in Safari and Firefox).
 */
export function MonthPicker({
  id,
  value,
  onChange,
  latest,
  count = DEFAULT_MONTH_COUNT,
  className,
  'aria-label': ariaLabel,
}: MonthPickerProps): React.JSX.Element {
  const options = monthOptions(latest ?? monthOf(new Date()), count, value);
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      className={cn('w-48', className)}
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
    </Select>
  );
}
