// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The customize controls of the Live dashboard. Dragging itself (pointer and
// keyboard) runs in the E2E dashboard spec: jsdom has no layout to measure.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      opts?.name != null ? `${key}:${opts.name}` : key,
  }),
}));

import { SortableZone } from '../SortableZone';
import { SortableWidget } from '../SortableWidget';
import { DashboardCustomizeBar, DashboardCustomizeButton } from '../DashboardCustomizeBar';
import dashboardSource from '../../../pages/Dashboard.tsx?raw';
import customizeBarSource from '../DashboardCustomizeBar.tsx?raw';

afterEach(() => {
  cleanup();
});

function zone(editing: boolean, onHide = vi.fn()): void {
  render(
    <SortableZone
      ids={['a', 'b']}
      names={{ a: 'Alpha', b: 'Beta' }}
      editing={editing}
      onMove={vi.fn()}
    >
      {['a', 'b'].map((id) => (
        <SortableWidget
          key={id}
          id={id}
          name={id === 'a' ? 'Alpha' : 'Beta'}
          editing={editing}
          onHide={onHide}
        >
          <p>{`content ${id}`}</p>
        </SortableWidget>
      ))}
    </SortableZone>,
  );
}

describe('dashboard customize controls', () => {
  it('renders the widgets alone outside edit mode', () => {
    zone(false);
    expect(screen.getByText('content a')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gives each widget a named drag handle and hide button in edit mode', () => {
    const onHide = vi.fn();
    zone(true, onHide);
    const handle = screen.getByRole('button', { name: 'dashboard.moveWidget:Alpha' });
    // The keyboard picks the widget up from the handle.
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.className).toContain('touch-none');
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.hideWidget:Beta' }));
    expect(onHide).toHaveBeenCalledWith('b');
  });

  it('switches the Customize button to Done', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DashboardCustomizeButton editing={false} onEditingChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.customize' }));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<DashboardCustomizeButton editing onEditingChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.doneCustomizing' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('is a 40 px icon button named by its label', () => {
    render(<DashboardCustomizeButton editing={false} onEditingChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'dashboard.customize' });
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.className).toContain('h-10');
    expect(button.className).toContain('w-10');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the Customize tooltip on the left of the button', () => {
    expect(customizeBarSource).toContain('<Tooltip content={label} side="left">');
  });

  it('keeps the dashboard mode toggle at the 40 px control height', () => {
    expect(dashboardSource).toContain('className={`h-10 px-3 text-sm font-medium');
  });

  it('shows hidden widgets back and resets after a confirmation', async () => {
    const onShow = vi.fn();
    const onReset = vi.fn();
    render(
      <DashboardCustomizeBar
        hidden={[{ id: 'chart.freeVend', name: 'Free Vend' }]}
        onShow={onShow}
        onReset={onReset}
        isResetting={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.showWidget:Free Vend' }));
    expect(onShow).toHaveBeenCalledWith('chart.freeVend');
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.resetLayout' }));
    expect(onReset).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'dashboard.resetLayout' }));
    expect(onReset).toHaveBeenCalled();
  });

  it('says when nothing is hidden', () => {
    render(
      <DashboardCustomizeBar hidden={[]} onShow={vi.fn()} onReset={vi.fn()} isResetting={false} />,
    );
    expect(screen.getByText('dashboard.noHiddenWidgets')).toBeTruthy();
  });
});
