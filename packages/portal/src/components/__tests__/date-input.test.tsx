// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The shared date picker: a typed day or a day picked in the shared calendar
// popover, replacing the browser's own date popup.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { DateInput } from '../ui/date-input';

afterEach(cleanup);

function Harness({
  initial = '',
  min,
  max,
  onValue,
}: {
  initial?: string;
  min?: string;
  max?: string;
  onValue: (v: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="day">Day</label>
      <DateInput
        id="day"
        value={value}
        min={min}
        max={max}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    </>
  );
}

function openCalendar(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'common.datePicker.open' }));
  return screen.getByRole('dialog', { name: 'common.datePicker.title' });
}

describe('DateInput', () => {
  it('is a 48 px text field named by its Label', () => {
    render(<Harness onValue={vi.fn()} />);
    const field = screen.getByLabelText<HTMLInputElement>('Day');
    expect(field.type).toBe('text');
    expect(field.className.split(/\s+/).filter((c) => /^h-\d/.test(c))).toEqual(['h-12']);
  });

  it('passes on a typed day in ISO or the locale form, and clears', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const field = screen.getByLabelText('Day');
    fireEvent.change(field, { target: { value: '2026-11' } });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '2026-11-22' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-22');
    fireEvent.change(field, { target: { value: '12/24/2026' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-12-24');
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe('2026-12-24');
    fireEvent.change(field, { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith('');
  });

  it('puts the last day back when a typed day is not a real day', () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-11-22" onValue={onValue} />);
    const field = screen.getByLabelText<HTMLInputElement>('Day');
    fireEvent.change(field, { target: { value: '2026-02-30' } });
    fireEvent.blur(field);
    expect(field.value).toBe('2026-11-22');
    expect(onValue).not.toHaveBeenCalled();
  });

  it('picks a day in the calendar and closes it', () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-11-22" onValue={onValue} />);
    const dialog = openCalendar();
    expect(within(dialog).getByLabelText<HTMLSelectElement>('common.datePicker.month').value).toBe(
      '11',
    );
    expect(within(dialog).getByLabelText<HTMLSelectElement>('common.datePicker.year').value).toBe(
      '2026',
    );
    const selected = within(dialog).getByRole('button', { name: /November 22, 2026/ });
    expect(selected.closest('[role="gridcell"]')?.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: /November 5, 2026/ }));
    expect(onValue).toHaveBeenLastCalledWith('2026-11-05');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Day').value).toBe('2026-11-05');
  });

  it('moves months with the buttons, the selects and the keyboard', () => {
    render(<Harness initial="2026-01-31" onValue={vi.fn()} />);
    const dialog = openCalendar();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'common.datePicker.previousMonth' }),
    );
    const month = within(dialog).getByLabelText<HTMLSelectElement>('common.datePicker.month');
    const year = within(dialog).getByLabelText<HTMLSelectElement>('common.datePicker.year');
    expect([month.value, year.value]).toEqual(['12', '2025']);
    fireEvent.change(year, { target: { value: '2027' } });
    month.focus();
    fireEvent.change(month, { target: { value: '2' } });
    // A month change keeps the focus on the control that made it.
    expect(document.activeElement).toBe(month);
    const feb28 = within(dialog).getByRole('button', { name: /February 28, 2027/ });
    fireEvent.keyDown(feb28, { key: 'ArrowRight' });
    expect(within(dialog).getByRole('button', { name: /March 1, 2027/ })).toBe(
      document.activeElement,
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'PageDown' });
    expect([month.value, year.value]).toEqual(['4', '2027']);
  });

  it('keeps the focus on Next Month, so a second Enter does not pick a day', () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-01-15" onValue={onValue} />);
    const dialog = openCalendar();
    const nextButton = within(dialog).getByRole('button', { name: 'common.datePicker.nextMonth' });
    nextButton.focus();
    fireEvent.click(nextButton);
    expect(document.activeElement).toBe(nextButton);
    fireEvent.click(nextButton);
    expect(document.activeElement).toBe(nextButton);
    expect(within(dialog).getByLabelText<HTMLSelectElement>('common.datePicker.month').value).toBe(
      '3',
    );
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'common.datePicker.title' })).toBeTruthy();
  });

  it('offers only days inside min and max', () => {
    render(<Harness initial="2026-11-15" min="2026-11-10" max="2026-11-20" onValue={vi.fn()} />);
    const dialog = openCalendar();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: /November 9, 2026/ }).disabled,
    ).toBe(true);
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: /November 10, 2026/ }).disabled,
    ).toBe(false);
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: /November 21, 2026/ }).disabled,
    ).toBe(true);
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'common.datePicker.nextMonth' })
        .disabled,
    ).toBe(true);
  });

  it('clears from the calendar and closes on Escape without passing it on', () => {
    const onValue = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    render(<Harness initial="2026-11-15" onValue={onValue} />);
    let dialog = openCalendar();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: /November 15, 2026/ }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
    dialog = openCalendar();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.datePicker.clear' }));
    expect(onValue).toHaveBeenLastCalledWith('');
  });

  it('marks an error and names the calendar button after the field', () => {
    render(<DateInput value="" onChange={vi.fn()} invalid aria-label="From" />);
    const field = screen.getByLabelText('From');
    expect(field.className).toContain('border-destructive');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'From common.datePicker.open' })).toBeTruthy();
  });
});
