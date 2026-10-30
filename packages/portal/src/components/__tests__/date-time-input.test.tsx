// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The portal date and time picker: the shared date field and hour and minute
// selects (48 px touch targets) in place of the browser's datetime-local picker.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { DateTimeInput } from '../ui/date-time-input';

afterEach(cleanup);

function Harness({ onValue }: { onValue: (v: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('2026-11-02T09:05');
  return (
    <>
      <label htmlFor="starts">Starts</label>
      <DateTimeInput
        id="starts"
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    </>
  );
}

describe('portal DateTimeInput', () => {
  it('uses 48 px controls named by the label', () => {
    render(<Harness onValue={vi.fn()} />);
    const date = screen.getByLabelText<HTMLInputElement>('Starts');
    expect(date.type).toBe('date');
    expect(date.className.split(/\s+/)).toContain('h-12');
    expect(screen.getByLabelText('common.hour').className.split(/\s+/)).toContain('h-12');
  });

  it('emits the datetime-local format', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('common.hour'), { target: { value: '17' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-02T17:05');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-03' } });
    expect(onValue).toHaveBeenLastCalledWith('2026-11-03T17:05');
  });
});
