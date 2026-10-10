// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-entity-neighbors', () => ({
  useEntityNeighbors: () => ({ prevId: 'a', nextId: null }),
}));

import { BackButton } from '../back-button';
import { EntityNavButtons } from '../entity-nav-buttons';

afterEach(() => {
  cleanup();
});

describe('detail page header buttons', () => {
  it('give the back button a 44 px touch target on small screens that never shrinks', () => {
    render(
      <MemoryRouter>
        <BackButton to="/invoices" />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'nav.back' });
    expect(button.className).toContain('h-11');
    expect(button.className).toContain('w-11');
    expect(button.className).toContain('sm:h-10');
    expect(button.className).toContain('shrink-0');
  });

  it('give the prev and next buttons 44 px touch targets on small screens', () => {
    render(
      <MemoryRouter>
        <EntityNavButtons resource="invoices" basePath="/invoices" currentId="b" />
      </MemoryRouter>,
    );
    for (const name of ['common.prev', 'common.next']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('h-11');
      expect(button.className).toContain('sm:w-10');
    }
  });
});
