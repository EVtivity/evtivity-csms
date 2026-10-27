// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';

function box(left: number, right: number): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 40,
    width: right - left,
    height: 40,
    x: left,
    y: 0,
  } as DOMRect;
}

describe('Tabs on a phone', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('scrolls the strip so a tab opened from a link is in view', () => {
    // A 360 px strip whose active tab sits at 500 to 600 px.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tablist') return box(16, 344);
      if (this.textContent === 'Conformance') return box(500, 600);
      return box(16, 100);
    });
    render(
      <Tabs value="conformance" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="company">Company</TabsTrigger>
          <TabsTrigger value="conformance">Conformance</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    // 600 - 344 + 24: the tab's right edge clears the strip's fade.
    expect(screen.getByRole('tablist').scrollLeft).toBe(280);
  });

  it('leaves the strip alone when the active tab is already visible', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tablist') return box(16, 344);
      return box(20, 120);
    });
    render(
      <Tabs value="company" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="company">Company</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole('tablist').scrollLeft).toBe(0);
  });
});
