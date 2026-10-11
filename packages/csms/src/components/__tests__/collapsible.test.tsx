// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Collapsible } from '../ui/collapsible';

afterEach(() => {
  cleanup();
});

describe('Collapsible', () => {
  it('starts closed, shows its summary, and renders the content only when opened', () => {
    const onOpenChange = vi.fn();
    render(
      <Collapsible title="Scope" summary="3 stations offline" onOpenChange={onOpenChange}>
        <p>table</p>
      </Collapsible>,
    );
    const trigger = screen.getByRole('button', { name: /Scope/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('3 stations offline')).toBeTruthy();
    expect(screen.queryByText('table')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const content = screen.getByText('table').parentElement;
    expect(trigger.getAttribute('aria-controls')).toBe(content?.id);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.click(trigger);
    expect(screen.queryByText('table')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('is a native button, so the keyboard toggles it', () => {
    render(
      <Collapsible title="Scope">
        <p>table</p>
      </Collapsible>,
    );
    const trigger = screen.getByRole('button', { name: 'Scope' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
  });
});
