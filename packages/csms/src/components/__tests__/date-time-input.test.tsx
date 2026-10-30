// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The shared date and time pickers: the date field and hour and minute
// selects that replace the browser's datetime-local and time pickers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { DateTimeInput, splitDateTime } from '../ui/date-time-input';
import { TimeInput, hourLabel, joinTime, splitTime } from '../ui/time-input';
import { Label } from '../ui/label';

afterEach(cleanup);

function heights(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter((c) => /^h-\d/.test(c));
}

function Harness({
  initial = '',
  seconds,
  onValue,
}: {
  initial?: string;
  seconds?: boolean;
  onValue: (v: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Label htmlFor="when">When</Label>
      <DateTimeInput
        id="when"
        value={value}
        seconds={seconds}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    </>
  );
}

describe('time helpers', () => {
  it('splits and joins times', () => {
    expect(splitTime('09:05')).toEqual({ hour: '09', minute: '05', second: '' });
    expect(splitTime('09:05:30')).toEqual({ hour: '09', minute: '05', second: '30' });
    expect(splitTime('')).toEqual({ hour: '', minute: '', second: '' });
    expect(joinTime('09', '', '', false)).toBe('09:00');
    expect(joinTime('09', '05', '', true)).toBe('09:05:00');
    expect(joinTime('', '05', '', false)).toBe('');
    expect(splitDateTime('2026-10-30T14:05')).toEqual({ date: '2026-10-30', time: '14:05' });
    expect(splitDateTime('bad')).toEqual({ date: '', time: '' });
  });

  it('labels hours in the UI language', () => {
    expect(hourLabel(13, 'en-US')).toBe('1 PM');
    expect(hourLabel(13, 'de')).toContain('13');
  });
});

describe('TimeInput', () => {
  it('emits HH:mm from the hour and minute selects', () => {
    const onChange = vi.fn();
    render(<TimeInput value="" onChange={onChange} aria-label="Start" />);
    fireEvent.change(screen.getByLabelText('Start common.hour'), { target: { value: '07' } });
    expect(onChange).toHaveBeenLastCalledWith('07:00');
    cleanup();
    render(<TimeInput value="07:00" onChange={onChange} aria-label="Start" />);
    fireEvent.change(screen.getByLabelText('Start common.minute'), { target: { value: '45' } });
    expect(onChange).toHaveBeenLastCalledWith('07:45');
    fireEvent.change(screen.getByLabelText('Start common.hour'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('offers no empty choice when allowEmpty is false', () => {
    render(<TimeInput value="07:00" allowEmpty={false} onChange={vi.fn()} aria-label="T" />);
    const hour = screen.getByLabelText<HTMLSelectElement>('T common.hour');
    expect(hour.options).toHaveLength(24);
  });

  it('is 40 px and marks an error', () => {
    render(<TimeInput value="" invalid onChange={vi.fn()} aria-label="T" />);
    const hour = screen.getByLabelText('T common.hour');
    expect(heights(hour)).toEqual(['h-10']);
    expect(hour.className).toContain('border-destructive');
    expect(hour.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('DateTimeInput', () => {
  it('is named by its Label through the date field', () => {
    render(<Harness onValue={vi.fn()} />);
    const date = screen.getByLabelText<HTMLInputElement>('When');
    expect(date.type).toBe('date');
    expect(heights(date)).toEqual(['h-10']);
  });

  it('emits the datetime-local format, midnight until a time is picked', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-11-02' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-02T00:00');
    fireEvent.change(screen.getByLabelText('common.hour'), { target: { value: '14' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-02T14:00');
    fireEvent.change(screen.getByLabelText('common.minute'), { target: { value: '30' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-02T14:30');
  });

  it('keeps a time picked before the date and clears to an empty value', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('common.hour'), { target: { value: '09' } });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-11-02' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-02T09:00');
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith('');
  });

  it('shows a stored value and keeps seconds', () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-11-02T08:15:20" seconds onValue={onValue} />);
    expect(screen.getByLabelText<HTMLInputElement>('When').value).toBe('2026-11-02');
    expect(screen.getByLabelText<HTMLSelectElement>('common.hour').value).toBe('08');
    expect(screen.getByLabelText<HTMLSelectElement>('common.second').value).toBe('20');
    fireEvent.change(screen.getByLabelText('common.minute'), { target: { value: '16' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-02T08:16:20');
  });

  it('bounds the date field by the day of min and max', () => {
    render(
      <DateTimeInput
        id="b"
        aria-label="B"
        value=""
        min="2026-11-01T10:00"
        max="2026-11-30T10:00"
        onChange={vi.fn()}
      />,
    );
    const date = screen.getByLabelText<HTMLInputElement>('B');
    expect(date.min).toBe('2026-11-01');
    expect(date.max).toBe('2026-11-30');
  });
});
