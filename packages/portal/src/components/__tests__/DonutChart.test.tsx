// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonutChart } from '../DonutChart';

describe('DonutChart', () => {
  it('renders with default props', () => {
    const { container } = render(
      <DonutChart value={50} max={100}>
        <span data-testid="center">50%</span>
      </DonutChart>,
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(screen.getByTestId('center')).toBeTruthy();
  });

  it('renders two circles (background and value)', () => {
    const { container } = render(<DonutChart value={75} max={100} />);
    const circles = container.querySelectorAll('circle');
    expect(circles).toHaveLength(2);
  });

  it('calculates stroke-dashoffset based on value/max ratio', () => {
    const { container } = render(<DonutChart value={50} max={100} size={160} strokeWidth={12} />);
    const circles = container.querySelectorAll('circle');
    const valueCircle = circles[1];
    const r = (160 - 12) / 2;
    const circumference = 2 * Math.PI * r;
    const expectedOffset = circumference * (1 - 50 / 100);
    expect(valueCircle?.getAttribute('stroke-dashoffset')).toBe(String(expectedOffset));
  });

  it('clamps value at max', () => {
    const { container } = render(<DonutChart value={150} max={100} size={160} strokeWidth={12} />);
    const circles = container.querySelectorAll('circle');
    const valueCircle = circles[1];
    expect(valueCircle?.getAttribute('stroke-dashoffset')).toBe('0');
  });

  it('handles zero max gracefully', () => {
    const { container } = render(<DonutChart value={0} max={0} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('renders children in center', () => {
    render(
      <DonutChart value={25} max={100}>
        <div data-testid="content">$25.00</div>
      </DonutChart>,
    );
    expect(screen.getByTestId('content').textContent).toBe('$25.00');
  });

  it('respects custom size', () => {
    const { container } = render(<DonutChart value={50} max={100} size={200} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('200');
    expect(svg?.getAttribute('height')).toBe('200');
  });
});
