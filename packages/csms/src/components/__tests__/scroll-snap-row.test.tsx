// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o == null ? key : `${key}(${Object.values(o).map(String).join(',')})`,
  }),
}));

import { ScrollSnapRow } from '../ui/scroll-snap-row';

afterEach(() => {
  cleanup();
});

const items = (n: number): { id: string; content: React.ReactNode }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${String(i)}`, content: <p>item {i}</p> }));

/** Lays out the track: items `width` apart, `clientWidth` in view. */
function layout(track: HTMLElement, width: number, clientWidth: number): void {
  Object.defineProperty(track, 'clientWidth', { configurable: true, value: clientWidth });
  Array.from(track.children).forEach((child, i) => {
    Object.defineProperty(child, 'offsetLeft', { configurable: true, value: i * width });
    Object.defineProperty(child, 'offsetWidth', { configurable: true, value: width });
  });
}

describe('ScrollSnapRow', () => {
  it('shows one dot per page for full-width items (Revenue cards)', () => {
    render(<ScrollSnapRow items={items(3)} testId="row" />);
    const dots = screen.getAllByRole('button');
    expect(dots).toHaveLength(3);
    expect(dots[0]?.getAttribute('aria-current')).toBe('true');
    expect(dots[0]?.getAttribute('aria-label')).toBe('dashboard.showPage(1,3)');
  });

  it('counts scroll positions, not items, when several fit, and follows the scroll', () => {
    render(<ScrollSnapRow items={items(5)} itemClassName="w-1/3" gap="gap-4" testId="row" />);
    const track = screen.getByTestId('row').firstElementChild as HTMLElement;
    layout(track, 316, 932);
    const scrollTo = vi.fn();
    track.scrollTo = scrollTo;
    fireEvent.scroll(track);
    // Three in view, five items: three positions.
    let dots = screen.getAllByRole('button');
    expect(dots).toHaveLength(3);
    Object.defineProperty(track, 'scrollLeft', { configurable: true, value: 632 });
    fireEvent.scroll(track);
    dots = screen.getAllByRole('button');
    expect(dots[2]?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(dots[1] as HTMLElement);
    expect(scrollTo).toHaveBeenCalledWith({ left: 316, behavior: 'smooth' });
  });

  it('shows no dots when everything fits', () => {
    render(<ScrollSnapRow items={items(3)} itemClassName="w-1/3" testId="row" />);
    const track = screen.getByTestId('row').firstElementChild as HTMLElement;
    layout(track, 316, 950);
    fireEvent.scroll(track);
    expect(screen.queryByTestId('scroll-snap-dots')).toBeNull();
  });
});
