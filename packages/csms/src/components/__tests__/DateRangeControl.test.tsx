// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { DateRangeControl } from '../DateRangeControl';

afterEach(cleanup);

// Independent reimplementation of the preset window (today - N days through
// today, local calendar dates) so the test does not assert the component
// against its own helper.
function expectedRange(days: number): { from: string; to: string } {
  const fmt = (d: Date): string =>
    `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - days);
  return { from: fmt(start), to: fmt(today) };
}

function getDateInputs(container: HTMLElement): HTMLInputElement[] {
  // The text fields of the two shared DateInput pickers.
  return [...container.querySelectorAll('input[placeholder="YYYY-MM-DD"]')] as HTMLInputElement[];
}

describe('DateRangeControl', () => {
  it('populates the date inputs with the preset-derived range', () => {
    const { container } = render(
      <DateRangeControl
        days={7}
        from={null}
        to={null}
        onPresetChange={() => {}}
        onCustomChange={() => {}}
      />,
    );
    const expected = expectedRange(7);
    const [start, end] = getDateInputs(container);
    expect(start?.value).toBe(expected.from);
    expect(end?.value).toBe(expected.to);
  });

  it('shows custom dates when set', () => {
    const { container } = render(
      <DateRangeControl
        days={7}
        from="2026-06-01"
        to="2026-06-03"
        onPresetChange={() => {}}
        onCustomChange={() => {}}
      />,
    );
    const [start, end] = getDateInputs(container);
    expect(start?.value).toBe('2026-06-01');
    expect(end?.value).toBe('2026-06-03');
  });

  it('switches to a custom range keeping the derived end date when start is edited', () => {
    const onCustomChange = vi.fn();
    const { container } = render(
      <DateRangeControl
        days={7}
        from={null}
        to={null}
        onPresetChange={() => {}}
        onCustomChange={onCustomChange}
      />,
    );
    const [start] = getDateInputs(container);
    if (start == null) throw new Error('start input missing');
    fireEvent.change(start, { target: { value: '2026-06-01' } });
    expect(onCustomChange).toHaveBeenCalledWith('2026-06-01', expectedRange(7).to);
  });

  it('applies minDate and maxDate bounds', () => {
    render(
      <DateRangeControl
        days={7}
        from="2026-01-01"
        to="2026-06-06"
        onPresetChange={() => {}}
        onCustomChange={() => {}}
        minDate="2026-01-01"
        maxDate="2026-06-06"
      />,
    );
    const button = (name: string): HTMLButtonElement =>
      screen.getByRole<HTMLButtonElement>('button', { name });
    fireEvent.click(button('common.startDate common.datePicker.open'));
    expect(button('common.datePicker.previousMonth').disabled).toBe(true);
    fireEvent.click(button('common.startDate common.datePicker.open'));
    fireEvent.click(button('common.endDate common.datePicker.open'));
    expect(button('common.datePicker.nextMonth').disabled).toBe(true);
  });
});
