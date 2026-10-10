// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TOAST_ACTION_DURATION_MS,
  TOAST_DURATIONS_MS,
  type ToastVariantName,
} from '@evtivity/lib/toast-durations';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ToastProvider, useToast } from '../ui/toast';

type ToastOpts = Parameters<ReturnType<typeof useToast>['toast']>[0];

function Raise({ opts }: { opts: ToastOpts[] }): React.JSX.Element {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        for (const o of opts) toast(o);
      }}
    >
      Raise
    </button>
  );
}

function raise(...opts: ToastOpts[]): void {
  render(
    <ToastProvider>
      <Raise opts={opts} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Raise' }));
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const VARIANTS: ToastVariantName[] = ['default', 'success', 'info', 'warning', 'destructive'];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastProvider auto-dismiss', () => {
  it.each(VARIANTS)('dismisses a %s toast after its default duration', (variant) => {
    raise({ variant, title: `A ${variant} toast` });
    advance(TOAST_DURATIONS_MS[variant] - 1);
    expect(screen.queryByText(`A ${variant} toast`)).not.toBeNull();
    advance(1);
    expect(screen.queryByText(`A ${variant} toast`)).toBeNull();
  });

  it('keeps a toast with an action longer, then dismisses it', () => {
    raise({ variant: 'info', title: 'Update', action: { label: 'View', href: '#' } });
    advance(TOAST_DURATIONS_MS.info);
    expect(screen.queryByText('Update')).not.toBeNull();
    advance(TOAST_ACTION_DURATION_MS - TOAST_DURATIONS_MS.info);
    expect(screen.queryByText('Update')).toBeNull();
  });

  it('resolves every toast, so none stays on screen', () => {
    raise(
      { variant: 'destructive', title: 'Error' },
      { variant: 'warning', title: 'Warning' },
      { variant: 'info', title: 'With action', action: { label: 'Open', onClick: vi.fn() } },
    );
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    advance(TOAST_ACTION_DURATION_MS);
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('pauses on hover and resumes with the remaining time', () => {
    raise({ variant: 'success', title: 'Saved' });
    advance(1_000);
    const toast = screen.getByRole('status');
    fireEvent.mouseEnter(toast);
    advance(TOAST_DURATIONS_MS.success * 3);
    expect(screen.queryByText('Saved')).not.toBeNull();
    fireEvent.mouseLeave(toast);
    advance(TOAST_DURATIONS_MS.success - 1_001);
    expect(screen.queryByText('Saved')).not.toBeNull();
    advance(1);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('pauses while focus is inside the toast', () => {
    raise({ variant: 'warning', title: 'Queued' });
    const close = screen.getByRole('button', { name: 'common.dismiss' });
    fireEvent.focus(close);
    advance(TOAST_DURATIONS_MS.warning * 2);
    expect(screen.queryByText('Queued')).not.toBeNull();
    fireEvent.blur(close);
    advance(TOAST_DURATIONS_MS.warning);
    expect(screen.queryByText('Queued')).toBeNull();
  });

  it('stays paused until both hover and focus end', () => {
    raise({ variant: 'success', title: 'Saved' });
    const toast = screen.getByRole('status');
    const close = screen.getByRole('button', { name: 'common.dismiss' });
    fireEvent.mouseEnter(toast);
    fireEvent.focus(close);
    fireEvent.mouseLeave(toast);
    advance(TOAST_DURATIONS_MS.success * 2);
    expect(screen.queryByText('Saved')).not.toBeNull();
  });
});

describe('ToastProvider close and accessibility', () => {
  it('runs onClose when the user closes the toast', () => {
    const onClose = vi.fn();
    raise({ variant: 'info', title: 'Update', onClose });
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(screen.queryByText('Update')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not run onClose when the toast times out', () => {
    const onClose = vi.fn();
    raise({ variant: 'info', title: 'Update', onClose });
    advance(TOAST_DURATIONS_MS.info);
    expect(screen.queryByText('Update')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('announces errors as alerts and other toasts as status in a live region', () => {
    raise({ variant: 'destructive', title: 'Failed' }, { variant: 'success', title: 'Saved' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Failed');
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(alert.parentElement?.getAttribute('aria-live')).toBe('polite');
  });

  it('turns off the slide-in animation for reduced motion', () => {
    raise({ variant: 'success', title: 'Saved' });
    expect(screen.getByRole('status').className).toContain('motion-reduce:animate-none');
  });
});
