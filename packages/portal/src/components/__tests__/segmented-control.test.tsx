// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Zap } from 'lucide-react';
import { SegmentedControl } from '../ui/segmented-control';

type View = 'energy' | 'power' | 'cost';

const OPTIONS = [
  { value: 'energy', label: 'Energy', icon: Zap },
  { value: 'power', label: 'Power' },
  { value: 'cost', label: 'Cost' },
] as const;

function Harness({ onChange }: { onChange?: (v: View) => void }): React.JSX.Element {
  const [value, setValue] = useState<View>('energy');
  return (
    <SegmentedControl<View>
      aria-label="Chart"
      className="w-full"
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={OPTIONS}
    />
  );
}

function radios(): HTMLElement[] {
  return screen.getAllByRole('radio');
}

afterEach(() => {
  cleanup();
});

describe('SegmentedControl', () => {
  it('renders a labeled radio group with one checked option in the tab order', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Chart' });
    expect(group.className.split(' ')).toEqual(
      expect.arrayContaining(['w-full', 'min-h-10', 'bg-muted', 'rounded-md', 'auto-cols-fr']),
    );
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().every((r) => r.getAttribute('type') === 'button')).toBe(true);
    expect(radios()[0]?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('selects an option on click', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Power' }));
    expect(onChange).toHaveBeenCalledWith('power');
    expect(screen.getByRole('radio', { name: 'Power' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Power' }).tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'Energy' }).tabIndex).toBe(-1);
  });

  it('does not report a click on the selected option as a change', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Energy' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves and selects with the arrow keys, wrapping, and Home and End', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [energy, power, cost] = radios();
    energy?.focus();
    fireEvent.keyDown(energy as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(power);
    expect(power?.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(power as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cost);
    fireEvent.keyDown(cost as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(energy);
    fireEvent.keyDown(energy as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cost);
    fireEvent.keyDown(cost as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(power);
    fireEvent.keyDown(power as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(energy);
    fireEvent.keyDown(energy as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(cost);
    expect(onChange.mock.calls.map((c) => c[0] as View)).toEqual([
      'power',
      'cost',
      'energy',
      'cost',
      'power',
      'energy',
      'cost',
    ]);
  });

  it('ignores other keys', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(radios()[0] as HTMLElement, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('styles the segments from theme tokens only, raised when selected', () => {
    render(<Harness />);
    const [checked, unchecked] = radios();
    const on = checked?.className.split(' ') ?? [];
    const off = unchecked?.className.split(' ') ?? [];
    expect(on).toEqual(
      expect.arrayContaining(['bg-card', 'text-foreground', 'border-border', 'shadow-xs']),
    );
    expect(off).toEqual(expect.arrayContaining(['text-muted-foreground', 'border-transparent']));
    for (const cls of [...on, ...off]) {
      expect(cls).not.toMatch(/\[#|\b(white|black|gray|slate|blue|green|red)-\d/);
    }
    expect(on).toEqual(
      expect.arrayContaining([
        'rounded-sm',
        'min-h-8',
        'focus-visible:ring-2',
        'motion-reduce:transition-none',
      ]),
    );
    expect(on).not.toContain('whitespace-nowrap');
  });

  it('keeps the first option focusable when the value matches none', () => {
    render(
      <SegmentedControl
        aria-label="Chart"
        value={'other' as View}
        onValueChange={() => undefined}
        options={OPTIONS}
      />,
    );
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('uses tighter padding and smaller text in the compact size, for many short labels', () => {
    render(
      <SegmentedControl
        size="compact"
        aria-label="Day of the Week"
        value="1"
        onValueChange={() => undefined}
        options={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({
          value: String(i),
          label,
        }))}
      />,
    );
    expect(radios()).toHaveLength(7);
    for (const option of radios()) {
      // No side padding on phones and no mid-word break: "MON" split on a 360 px screen.
      expect(option.className.split(' ')).toEqual(
        expect.arrayContaining(['px-0', 'sm:px-2', 'text-xs', 'whitespace-nowrap']),
      );
      expect(option.className).not.toContain('px-3');
    }
    expect(screen.getByRole('radio', { name: 'Mon' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the default padding and text size without a size', () => {
    render(<Harness />);
    expect(radios()[0]?.className.split(' ')).toEqual(expect.arrayContaining(['px-3', 'text-sm']));
  });
});
