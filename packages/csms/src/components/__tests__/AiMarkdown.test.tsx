// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiMarkdown } from '../AiMarkdown';

describe('AiMarkdown', () => {
  it('renders GitHub-flavored markdown tables', () => {
    render(<AiMarkdown content={'| Site | kWh |\n|---|---|\n| North | 12 |'} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'North' })).toBeTruthy();
  });

  it('opens links in a new tab without leaking the opener', () => {
    render(<AiMarkdown content="[docs](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
