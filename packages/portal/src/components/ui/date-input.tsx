// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addDays,
  addMonths,
  addMonthsToDay,
  dayInRange,
  daysInMonth,
  firstDayOfWeek,
  isIsoDay,
  isoDay,
  monthWeeks,
  parseTypedDay,
  splitIsoDay,
  todayIsoDay,
  weekdayOf,
} from '@evtivity/lib/calendar-date';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

function uiLocale(): string {
  return i18next.isInitialized ? i18next.language : 'en';
}

/** Space the calendar needs below the field before it opens above it. */
const CALENDAR_HEIGHT_PX = 380;
/** Width of the calendar (20rem), to open it toward the side with room. */
const CALENDAR_WIDTH_PX = 320;

export interface DateInputProps {
  /** Id of the text field, so a `Label htmlFor` names the control. */
  id?: string | undefined;
  /** `YYYY-MM-DD`, '' when unset. No time zone: the caller keeps its own. */
  value: string;
  onChange: (value: string) => void;
  /** Earliest and latest day (`YYYY-MM-DD`) the calendar offers. */
  min?: string | undefined;
  max?: string | undefined;
  disabled?: boolean | undefined;
  /** Draws the field in the error color (a form error after a submit). */
  invalid?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  /** Classes of the outer element: width and layout only (`w-auto`, `w-40`, `flex-1`). */
  className?: string | undefined;
}

function dayLabel(value: string, locale: string): string {
  const parts = splitIsoDay(value);
  if (parts == null) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)),
  );
}

function monthName(month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 1, 12)),
  );
}

function weekdayNames(firstDay: number, locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2000-01-02 was a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    format.format(new Date(Date.UTC(2000, 0, 2 + ((firstDay + i) % 7), 12))),
  );
}

/**
 * The shared date picker: a text field that takes a typed day (`YYYY-MM-DD`,
 * or the UI language's numeric form such as 11/22/2026) and a calendar button
 * that opens the shared calendar popover, with month and year selects, the
 * days of the month, Today and Clear. Every browser shows the same control;
 * the native date input shows its own popup, which differs per browser and
 * matches none of the app's dropdowns. The value is the native input's
 * `YYYY-MM-DD`, so it replaces `<Input type="date">` without changing how the
 * caller reads it. Like the native input, a typed day outside `min` and
 * `max` is still passed on; the calendar offers only days inside them.
 */
export function DateInput({
  id,
  value,
  onChange,
  min,
  max,
  disabled,
  invalid,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  className,
}: DateInputProps): React.JSX.Element {
  const { t } = useTranslation();
  const locale = uiLocale();
  const [text, setText] = React.useState(value);
  const [open, setOpen] = React.useState(false);
  const [above, setAbove] = React.useState(false);
  const [alignEnd, setAlignEnd] = React.useState(false);
  const [focusDay, setFocusDay] = React.useState('');
  const containerRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  // Set by opening the calendar and by the grid keys only: a month change from the
  // buttons or selects keeps the focus where it was (WAI-ARIA APG date picker dialog).
  const focusGridRef = React.useRef(false);
  const popoverId = React.useId();

  // Follow a value the caller changed; a partly typed day stays while it is typed.
  React.useEffect(() => {
    setText((current) => (parseTypedDay(current, uiLocale()) === value ? current : value));
  }, [value]);

  const today = todayIsoDay();
  const view = splitIsoDay(focusDay) ?? splitIsoDay(isIsoDay(value) ? value : today);

  function openCalendar(): void {
    if (disabled === true) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect != null && typeof window !== 'undefined') {
      const below = window.innerHeight - rect.bottom;
      setAbove(below < CALENDAR_HEIGHT_PX && rect.top > below);
      setAlignEnd(
        rect.left + CALENDAR_WIDTH_PX > window.innerWidth && rect.right > CALENDAR_WIDTH_PX,
      );
    }
    const start = isIsoDay(value) ? value : today;
    focusGridRef.current = true;
    setFocusDay(dayInRange(start, min, max) ? start : (min ?? max ?? start));
    setOpen(true);
  }

  function closeCalendar(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function pick(day: string): void {
    setText(day);
    onChange(day);
    closeCalendar(true);
  }

  React.useEffect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent): void {
      if (containerRef.current != null && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleDown);
    return () => {
      document.removeEventListener('mousedown', handleDown);
    };
  }, [open]);

  // Move the keyboard focus to the focused day after an open or a grid key.
  React.useEffect(() => {
    if (!open || focusDay === '' || !focusGridRef.current) return;
    focusGridRef.current = false;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`);
    if (el != null && document.activeElement !== el) el.focus();
  }, [open, focusDay]);

  function moveFocus(next: string): void {
    if (!isIsoDay(next)) return;
    if (min != null && min !== '' && next < min) setFocusDay(min);
    else if (max != null && max !== '' && next > max) setFocusDay(max);
    else setFocusDay(next);
  }

  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const keys: Record<string, () => string> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      PageUp: () => addMonthsToDay(focusDay, e.shiftKey ? -12 : -1),
      PageDown: () => addMonthsToDay(focusDay, e.shiftKey ? 12 : 1),
      Home: () => addDays(focusDay, -((weekdayOf(focusDay) - firstDay + 7) % 7)),
      End: () => addDays(focusDay, 6 - ((weekdayOf(focusDay) - firstDay + 7) % 7)),
    };
    const next = keys[e.key];
    if (next != null) {
      e.preventDefault();
      focusGridRef.current = true;
      moveFocus(next());
    }
  }

  function handlePopoverKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      // Consumed, so a dialog around the field stays open.
      e.preventDefault();
      e.stopPropagation();
      closeCalendar(true);
    }
  }

  const firstDay = firstDayOfWeek(locale);
  const viewYear = view?.year ?? new Date().getFullYear();
  const viewMonth = view?.month ?? 1;
  const weeks = monthWeeks(viewYear, viewMonth, firstDay);
  const currentYear = new Date().getFullYear();
  const minYear = splitIsoDay(min ?? '')?.year ?? Math.min(currentYear - 20, viewYear);
  const maxYear = splitIsoDay(max ?? '')?.year ?? Math.max(currentYear + 10, viewYear);
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
  const prev = addMonths(viewYear, viewMonth, -1);
  const next = addMonths(viewYear, viewMonth, 1);
  const minMonth = (min ?? '').slice(0, 7);
  const maxMonth = (max ?? '').slice(0, 7);
  const prevDisabled = minMonth !== '' && isoDay(prev.year, prev.month, 1).slice(0, 7) < minMonth;
  const nextDisabled = maxMonth !== '' && isoDay(next.year, next.month, 1).slice(0, 7) > maxMonth;

  function showMonth(year: number, month: number): void {
    focusGridRef.current = false;
    const day = Math.min(splitIsoDay(focusDay)?.day ?? 1, daysInMonth(year, month));
    moveFocus(isoDay(year, month, day));
  }

  return (
    <div ref={containerRef} className={cn('relative w-full', className)}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        placeholder="YYYY-MM-DD"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid === true ? true : undefined}
        // The bounds the field holds, as the native input's min and max did.
        data-min={min}
        data-max={max}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const typed = e.target.value;
          setText(typed);
          if (typed.trim() === '') {
            if (value !== '') onChange('');
            return;
          }
          const day = parseTypedDay(typed, locale);
          if (day != null && day !== value) onChange(day);
        }}
        onBlur={() => {
          const day = parseTypedDay(text, locale);
          setText(day ?? value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && e.altKey) {
            e.preventDefault();
            openCalendar();
          }
        }}
        className={cn('pr-10', invalid === true && 'border-destructive')}
      />
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={
          ariaLabel != null
            ? `${ariaLabel} ${t('common.datePicker.open')}`
            : t('common.datePicker.open')
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => {
          if (open) closeCalendar(false);
          else openCalendar();
        }}
        className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-3 text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CalendarDays className="h-4 w-4" />
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={t('common.datePicker.title')}
          onKeyDown={handlePopoverKeyDown}
          className={cn(
            'absolute z-30 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md',
            above ? 'bottom-full mb-1' : 'top-full mt-1',
            alignEnd ? 'right-0' : 'left-0',
          )}
        >
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="w-8 shrink-0"
              aria-label={t('common.datePicker.previousMonth')}
              disabled={prevDisabled}
              onClick={() => {
                showMonth(prev.year, prev.month);
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Select
              aria-label={t('common.datePicker.month')}
              value={String(viewMonth)}
              onChange={(e) => {
                showMonth(viewYear, Number(e.target.value));
              }}
              className="min-w-0 flex-1"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={String(m)}>
                  {monthName(m, locale)}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t('common.datePicker.year')}
              value={String(viewYear)}
              onChange={(e) => {
                showMonth(Number(e.target.value), viewMonth);
              }}
              className="w-24 shrink-0"
            >
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="w-8 shrink-0"
              aria-label={t('common.datePicker.nextMonth')}
              disabled={nextDisabled}
              onClick={() => {
                showMonth(next.year, next.month);
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div ref={gridRef} role="grid" onKeyDown={handleGridKeyDown} className="mt-2">
            <div role="row" className="grid grid-cols-7">
              {weekdayNames(firstDay, locale).map((name) => (
                <div
                  key={name}
                  role="columnheader"
                  className="py-1 text-center text-xs font-medium text-muted-foreground"
                >
                  {name}
                </div>
              ))}
            </div>
            {weeks.map((week) => (
              <div key={week.find((d) => d != null) ?? ''} role="row" className="grid grid-cols-7">
                {week.map((day, i) =>
                  day == null ? (
                    <div key={`empty-${String(i)}`} role="gridcell" />
                  ) : (
                    <div key={day} role="gridcell" aria-selected={day === value}>
                      <button
                        type="button"
                        data-day={day}
                        tabIndex={day === focusDay ? 0 : -1}
                        disabled={!dayInRange(day, min, max)}
                        aria-label={dayLabel(day, locale)}
                        aria-current={day === today ? 'date' : undefined}
                        onClick={() => {
                          pick(day);
                        }}
                        className={cn(
                          'mx-auto flex h-10 w-10 items-center justify-center rounded-md text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40',
                          day === today &&
                            day !== value &&
                            'font-semibold ring-1 ring-inset ring-ring',
                          day === value &&
                            'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                        )}
                      >
                        {Number(day.slice(8, 10))}
                      </button>
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!dayInRange(today, min, max)}
              onClick={() => {
                pick(today);
              }}
            >
              {t('common.datePicker.today')}
            </Button>
            {value !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setText('');
                  onChange('');
                  closeCalendar(true);
                }}
              >
                {t('common.datePicker.clear')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
