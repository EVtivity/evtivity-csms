// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const pad = (n: number): string => String(n).padStart(2, '0');

/** The hour, minute and second of `HH:mm` or `HH:mm:ss`, '' when absent or malformed. */
export function splitTime(value: string): { hour: string; minute: string; second: string } {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (m == null) return { hour: '', minute: '', second: '' };
  return { hour: m[1] ?? '', minute: m[2] ?? '', second: m[3] ?? '' };
}

/** `HH:mm` (or `HH:mm:ss` with `seconds`), the value a native time input gives. */
export function joinTime(hour: string, minute: string, second: string, seconds: boolean): string {
  if (hour === '') return '';
  const base = `${hour}:${minute === '' ? '00' : minute}`;
  return seconds ? `${base}:${second === '' ? '00' : second}` : base;
}

/** "1 PM" (en) or "13 Uhr" (de): the hour in the UI language, for the hour option label. */
export function hourLabel(hour: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2000, 0, 1, hour)),
    );
  } catch (err: unknown) {
    console.warn('hourLabel: unsupported locale', locale, err);
    return pad(hour);
  }
}

export interface TimeInputProps {
  /** Id of the hour select, so a `Label htmlFor` names the field. */
  id?: string | undefined;
  /** `HH:mm` (or `HH:mm:ss` with `seconds`); '' when no time is set. */
  value: string;
  onChange: (value: string) => void;
  /** Adds a seconds select; the value is then `HH:mm:ss`. */
  seconds?: boolean | undefined;
  /** Offers an empty choice ('--') so the time can be cleared. Default true. */
  allowEmpty?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Draws the border in the error color (a form error after a submit). */
  invalid?: boolean | undefined;
  /** Names the field for screen readers when no `Label htmlFor` points at `id`. */
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  className?: string | undefined;
}

/**
 * The shared time picker: shared `Select`s for the hour (labelled in the UI
 * language), the minute and optionally the second. Every browser shows the
 * same control; the native time input differs per browser and has no picker
 * in Firefox. The value has the native input's format, so it is a drop-in
 * replacement.
 */
export function TimeInput({
  id,
  value,
  onChange,
  seconds = false,
  allowEmpty = true,
  disabled,
  invalid,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  className,
}: TimeInputProps): React.JSX.Element {
  const { t } = useTranslation();
  const locale = i18next.isInitialized ? i18next.language : 'en';
  const parts = splitTime(value);
  const empty = parts.hour === '';
  const showEmpty = allowEmpty || empty;
  const name = (part: string): string => (ariaLabel != null ? `${ariaLabel} ${part}` : part);
  const border = invalid === true ? 'border-destructive' : undefined;

  function emit(hour: string, minute: string, second: string): void {
    onChange(joinTime(hour, minute, second, seconds));
  }

  const units = (count: number): string[] => Array.from({ length: count }, (_, i) => pad(i));

  return (
    <div role="group" className={cn('flex gap-2', className)}>
      <Select
        id={id}
        aria-label={name(t('common.hour'))}
        aria-describedby={describedBy}
        aria-invalid={invalid === true ? true : undefined}
        disabled={disabled}
        value={parts.hour}
        onChange={(e) => {
          emit(e.target.value, parts.minute, parts.second);
        }}
        className={cn('w-28', border)}
      >
        {showEmpty && <option value="">--</option>}
        {units(24).map((h) => (
          <option key={h} value={h}>
            {hourLabel(Number(h), locale)}
          </option>
        ))}
      </Select>
      <Select
        aria-label={name(t('common.minute'))}
        aria-invalid={invalid === true ? true : undefined}
        disabled={disabled}
        value={parts.minute}
        onChange={(e) => {
          emit(parts.hour === '' ? '00' : parts.hour, e.target.value, parts.second);
        }}
        className={cn('w-20', border)}
      >
        {showEmpty && <option value="">--</option>}
        {units(60).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
      {seconds && (
        <Select
          aria-label={name(t('common.second'))}
          aria-invalid={invalid === true ? true : undefined}
          disabled={disabled}
          value={parts.second}
          onChange={(e) => {
            emit(parts.hour === '' ? '00' : parts.hour, parts.minute, e.target.value);
          }}
          className={cn('w-20', border)}
        >
          {showEmpty && <option value="">--</option>}
          {units(60).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
