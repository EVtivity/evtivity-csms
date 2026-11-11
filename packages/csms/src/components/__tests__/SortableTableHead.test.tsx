// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { Table, TableHeader, TableRow } from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { useListSort, type ListSort } from '@/hooks/use-list-sort';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

function renderHead(sort: Pick<ListSort<'name'>, 'sort' | 'order' | 'toggle'> | undefined) {
  render(
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="name" sort={sort}>
            Name
          </SortableTableHead>
        </TableRow>
      </TableHeader>
    </Table>,
  );
}

function ListHeader(): ReactNode {
  const sort = useListSort(['name', 'createdAt'] as const);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead sortKey="name" sort={sort}>
            Name
          </SortableTableHead>
          <SortableTableHead sortKey="createdAt" sort={sort}>
            Created
          </SortableTableHead>
        </TableRow>
      </TableHeader>
    </Table>
  );
}

describe('SortableTableHead', () => {
  it('renders a plain header without a sort', () => {
    renderHead(undefined);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names the next step and has no aria-sort while not sorted', () => {
    const toggle = vi.fn();
    renderHead({ sort: null, order: 'asc', toggle });
    const header = screen.getByRole('columnheader');
    expect(header.getAttribute('aria-sort')).toBeNull();
    const button = screen.getByRole('button', { name: 'Name, common.sortAscending' });
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith('name');
  });

  it('shows ascending and descending in aria-sort', () => {
    renderHead({ sort: 'name', order: 'asc', toggle: vi.fn() });
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('button', { name: 'Name, common.sortDescending' })).toBeTruthy();
    cleanup();
    renderHead({ sort: 'name', order: 'desc', toggle: vi.fn() });
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('button', { name: 'Name, common.sortDefault' })).toBeTruthy();
  });

  it('sorts from the keyboard and keeps one sorted column', () => {
    window.history.replaceState(null, '', '/sites');
    render(createElement(BrowserRouter, null, createElement(ListHeader)));
    const nameButton = screen.getByTestId('sort-name');
    nameButton.focus();
    expect(document.activeElement).toBe(nameButton);
    // A native button: Enter and Space click it.
    fireEvent.click(nameButton);
    expect(window.location.search).toBe('?sort=name&order=asc');
    fireEvent.click(screen.getByTestId('sort-createdAt'));
    expect(window.location.search).toBe('?sort=createdAt&order=asc');
    const headers = screen.getAllByRole('columnheader');
    expect(headers[0]?.getAttribute('aria-sort')).toBeNull();
    expect(headers[1]?.getAttribute('aria-sort')).toBe('ascending');
  });
});
