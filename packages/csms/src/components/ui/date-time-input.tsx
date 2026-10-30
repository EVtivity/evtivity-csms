// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { TimeInput } from '@/components/ui/time-input';
import { cn } from '@/lib/utils';

/** The date (`YYYY-MM-DD`) and time (`HH:mm[:ss]`) of a `YYYY-MM-DDTHH:mm[:ss]` value. */
export function splitDateTime(value: string): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)/.exec(value);
  if (m == null) return { date: '', time: '' };
  return { date: m[1] ?? '', time: m[2] ?? '' };
}

export interface DateTimeInputProps {
  /** Id of the date field, so a `Label htmlFor` names the control. */
  id?: string | undefined;
  /** `YYYY-MM-DDTHH:mm` (or `...:ss` with `seconds`) in local time; '' when unset. */
  value: string;
  onChange: (value: string) => void;
  /** Earliest and latest value (`YYYY-MM-DDTHH:mm`); only the day bounds the date field. */
  min?: string | undefined;
  max?: string | undefined;
  /** Adds a seconds select. */
  seconds?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Draws every part in the error color (a form error after a submit). */
  invalid?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  className?: string | undefined;
}

/**
 * The shared date and time picker: the shared date `Input` and the shared
 * `TimeInput` (hour and minute selects). It replaces `<input
 * type="datetime-local">`, whose picker differs per browser (a combined
 * calendar and time column popup in Chrome, a date-only popup in Firefox and
 * Safari). The value keeps the datetime-local format, so callers parse it the
 * same way (`new Date(value)` reads local time). While the date is empty the
 * value is '' and a picked time waits for the date; once a date is set the
 * time is always concrete (midnight until picked).
 */
export function DateTimeInput({
  id,
  value,
  onChange,
  min,
  max,
  seconds = false,
  disabled,
  invalid,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  className,
}: DateTimeInputProps): React.JSX.Element {
  const { date, time } = splitDateTime(value);
  // The time picked before a date, kept until the date is set.
  const [draftTime, setDraftTime] = useState('');
  const shownTime = date === '' ? draftTime : time;
  const midnight = seconds ? '00:00:00' : '00:00';

  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      <Input
        id={id}
        type="date"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid === true ? true : undefined}
        disabled={disabled}
        min={min?.slice(0, 10)}
        max={max?.slice(0, 10)}
        value={date}
        onChange={(e) => {
          const nextDate = e.target.value;
          if (nextDate === '') {
            setDraftTime(time);
            onChange('');
            return;
          }
          onChange(`${nextDate}T${shownTime === '' ? midnight : shownTime}`);
        }}
        className={cn('min-w-40 flex-1 basis-40', invalid === true && 'border-destructive')}
      />
      <TimeInput
        value={shownTime}
        seconds={seconds}
        allowEmpty={date === ''}
        disabled={disabled}
        invalid={invalid}
        aria-label={ariaLabel}
        onChange={(nextTime) => {
          if (date === '') {
            setDraftTime(nextTime);
            return;
          }
          onChange(`${date}T${nextTime === '' ? midnight : nextTime}`);
        }}
      />
    </div>
  );
}
