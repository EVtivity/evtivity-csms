// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AlertTriangle } from 'lucide-react';
import { Card } from '../ui/card';
import { DescriptionItem, DescriptionList } from '../ui/description-list';
import { IconBadge } from '../ui/icon-badge';

afterEach(() => {
  cleanup();
});

describe('IconBadge', () => {
  it.each([
    ['info', 'bg-info', 'text-on-tone'],
    ['warning', 'bg-warning', 'text-on-tone'],
    ['destructive', 'bg-destructive', 'text-on-tone'],
    ['success', 'bg-success', 'text-on-tone'],
    ['muted', 'bg-muted-foreground', 'text-card'],
  ] as const)('%s is a solid fill with contrasting ink', (tone, fill, ink) => {
    render(<IconBadge icon={AlertTriangle} tone={tone} label="Faulted" />);
    const badge = screen.getByRole('img', { name: 'Faulted' });
    expect(badge.className).toContain(fill);
    expect(badge.className).toContain(ink);
  });

  it('is hidden from assistive tech without a label', () => {
    const { container } = render(<IconBadge icon={AlertTriangle} tone="info" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('DescriptionList', () => {
  it('stacks on phones and uses a label column from sm', () => {
    render(
      <DescriptionList data-testid="list">
        <DescriptionItem label="Likely cause" valueTestId="value">
          Hardware
        </DescriptionItem>
      </DescriptionList>,
    );
    const classes = screen.getByTestId('list').className.split(' ');
    expect(classes).toContain('grid-cols-1');
    expect(classes).toContain('sm:grid-cols-[max-content_1fr]');
    expect(screen.getByText('Likely cause').tagName).toBe('DT');
    expect(screen.getByTestId('value').textContent).toBe('Hardware');
  });
});

describe('Card accent', () => {
  it('adds a left border in the tone', () => {
    render(<Card accent="warning" data-testid="card" />);
    const classes = screen.getByTestId('card').className.split(' ');
    expect(classes).toContain('border-l-4');
    expect(classes).toContain('border-l-warning');
  });
});
