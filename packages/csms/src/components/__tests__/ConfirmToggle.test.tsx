// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      opts?.name != null ? `${key}:${opts.name}` : key,
  }),
}));

import { ConfirmToggle } from '../ui/confirm-toggle';

afterEach(() => {
  cleanup();
});

function Harness({
  initial,
  onChange,
  offDescription,
}: {
  initial: boolean;
  onChange: (v: boolean) => void;
  offDescription?: string;
}): React.JSX.Element {
  const [checked, setChecked] = useState(initial);
  return (
    <ConfirmToggle
      aria-label="Station insights"
      label="Station insights"
      {...(offDescription != null ? { offDescription } : {})}
      checked={checked}
      onCheckedChange={(v) => {
        setChecked(v);
        onChange(v);
      }}
    />
  );
}

describe('ConfirmToggle', () => {
  it('turns on at once without asking', () => {
    const onChange = vi.fn();
    render(<Harness initial={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Station insights' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('asks before turning off, naming the setting and what stops', () => {
    const onChange = vi.fn();
    render(<Harness initial onChange={onChange} offDescription="No new insights are made." />);
    fireEvent.click(screen.getByRole('switch', { name: 'Station insights' }));
    expect(onChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('common.toggleOff.title');
    expect(dialog.textContent).toContain('common.toggleOff.description:Station insights');
    expect(screen.getByTestId('confirm-toggle-off-effect').textContent).toContain(
      'No new insights are made.',
    );
  });

  it('keeps it on when cancelled', () => {
    const onChange = vi.fn();
    render(<Harness initial onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'common.toggleOff.cancel' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('turns off on confirm with onCheckedChange(false)', () => {
    const onChange = vi.fn();
    render(<Harness initial onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.queryByTestId('confirm-toggle-off-effect')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.toggleOff.confirm' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('returns focus to the switch when the dialog closes', () => {
    render(<Harness initial onChange={vi.fn()} />);
    const toggle = screen.getByRole('switch');
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'common.toggleOff.cancel' }));
    expect(document.activeElement).toBe(toggle);
  });
});
