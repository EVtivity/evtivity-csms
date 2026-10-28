// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { PricingGroup } from '@/lib/types';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }));

import { PricingGroupPickList } from '../PricingGroupPickList';
import { StationAssignPricing } from '@/pages/StationAssignPricing';

const groups = [
  { id: 'pg_a', name: 'Standard', description: null, isDefault: true },
  { id: 'pg_b', name: 'Fleet Rate', description: 'For fleets', isDefault: false },
] as unknown as PricingGroup[];

function isDisabled(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.disabled;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList(currentGroupId: string | null, onSelect = vi.fn()) {
  render(
    <PricingGroupPickList
      groups={groups}
      currentGroupId={currentGroupId}
      pendingGroupId={null}
      isPending={false}
      emptyLabel="empty"
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe('PricingGroupPickList', () => {
  it('highlights the current group with a badge and makes it not selectable', () => {
    const onSelect = renderList('pg_a');
    const current = screen.getByTestId('pricing-group-option-pg_a');
    expect(isDisabled(current)).toBe(true);
    expect(current.getAttribute('aria-disabled')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(current.getAttribute('title')).toBe('pricing.currentGroupNotSelectable');
    expect(current.className).toContain('bg-accent');
    expect(current.textContent).toContain('pricing.currentGroup');
    fireEvent.click(current);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the other groups selectable', () => {
    const onSelect = renderList('pg_a');
    const other = screen.getByTestId('pricing-group-option-pg_b');
    expect(isDisabled(other)).toBe(false);
    expect(other.hasAttribute('aria-current')).toBe(false);
    expect(other.textContent).not.toContain('pricing.currentGroup');
    fireEvent.click(other);
    expect(onSelect).toHaveBeenCalledWith(groups[1]);
  });

  it('changes nothing without a current group', () => {
    const onSelect = renderList(null);
    for (const group of groups) {
      const option = screen.getByTestId(`pricing-group-option-${group.id}`);
      expect(isDisabled(option)).toBe(false);
      expect(option.hasAttribute('title')).toBe(false);
    }
    expect(screen.queryByText('pricing.currentGroup')).toBeNull();
    fireEvent.click(screen.getByTestId('pricing-group-option-pg_a'));
    expect(onSelect).toHaveBeenCalledWith(groups[0]);
  });

  it('shows the empty label when there are no groups', () => {
    render(
      <PricingGroupPickList
        groups={[]}
        currentGroupId="pg_a"
        pendingGroupId={null}
        isPending={false}
        emptyLabel="no groups"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('no groups')).toBeTruthy();
  });
});

describe('StationAssignPricing', () => {
  it('marks the station pricing group as current and asks to confirm another one', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(url === '/v1/pricing-groups' ? groups : groups[1]),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/stations/st_1/pricing/add']}>
          <Routes>
            <Route path="/stations/:id/pricing/add" element={<StationAssignPricing />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(isDisabled(screen.getByTestId('pricing-group-option-pg_b'))).toBe(true);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/stations/st_1/pricing-groups');
    const other = screen.getByTestId('pricing-group-option-pg_a');
    expect(isDisabled(other)).toBe(false);
    fireEvent.click(other);
    expect(await screen.findByText('stations.confirmAssignPricing')).toBeTruthy();
  });
});
