// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ScrollFade } from '../ui/scroll-fade';

function size(scrollWidth: number, clientWidth: number): () => void {
  const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => clientWidth,
  });
  return () => {
    if (sw != null) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', sw);
    if (cw != null) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw);
  };
}

describe('ScrollFade', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the right fade with a scroll button when the line does not fit', () => {
    const restore = size(600, 300);
    const scrollBy = vi.fn();
    HTMLElement.prototype.scrollBy = scrollBy;
    render(
      <ScrollFade surface="background">
        <h1>A very long detail page title</h1>
      </ScrollFade>,
    );
    expect(screen.queryByRole('button', { name: 'common.scrollLeft' })).toBeNull();
    const right = screen.getByRole('button', { name: 'common.scrollRight' });
    expect(right.className).toContain('from-background');
    fireEvent.click(right);
    expect(scrollBy).toHaveBeenCalledWith({ left: 120, behavior: 'smooth' });
    restore();
  });

  it('shows no fade when everything fits', () => {
    const restore = size(200, 300);
    render(
      <ScrollFade>
        <span>Short</span>
      </ScrollFade>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Short')).toBeTruthy();
    restore();
  });
});
