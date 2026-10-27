// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TabPanel } from '../ui/tab-panel';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '../ui/content-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

afterEach(() => {
  cleanup();
});

describe('TabPanel', () => {
  it('shows the title, description, actions and padded body', () => {
    render(
      <TabPanel title="Sessions" description="Every session" actions={<button>Add</button>}>
        <span>Body</span>
      </TabPanel>,
    );
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeTruthy();
    expect(screen.getByText('Every session').className).toContain('text-muted-foreground');
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    const body = screen.getByText('Body').parentElement;
    expect(body?.className).toContain('p-6');
    expect(body?.className).toContain('pt-0');
    const header = screen.getByRole('heading', { name: 'Sessions' }).closest('div')?.parentElement;
    expect(header?.className).toContain('sm:flex-row');
    expect(header?.className).toContain('flex-col');
    expect(screen.getByTestId('tab-panel')).toBeTruthy();
  });

  it('keeps inline actions beside the title at every width', () => {
    render(
      <TabPanel title="Matching Stations" actionsPosition="inline" actions={<select />}>
        x
      </TabPanel>,
    );
    const header = screen
      .getByRole('heading', { name: 'Matching Stations' })
      .closest('div')?.parentElement;
    expect(header?.className).toContain('flex-row');
    expect(header?.className).not.toContain('flex-col');
    expect(screen.getByRole('combobox').parentElement?.className).toContain('shrink-0');
  });

  it('runs a flush body edge to edge', () => {
    render(
      <TabPanel title="History" body="flush">
        <span>Table</span>
      </TabPanel>,
    );
    const body = screen.getByText('Table').parentElement;
    expect(body?.className).toContain('p-0');
    expect(body?.className).not.toContain('p-6');
  });

  it('pads a panel without a header from the top', () => {
    render(
      <TabPanel>
        <span>Filters</span>
      </TabPanel>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Filters').parentElement?.className).toContain('pt-6');
  });

  it('shows loading before error before empty, instead of the body', () => {
    const { rerender } = render(
      <TabPanel title="T" isLoading isError isEmpty emptyMessage="Nothing">
        <span>Body</span>
      </TabPanel>,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('Body')).toBeNull();

    const onRetry = vi.fn();
    rerender(
      <TabPanel title="T" isError onRetry={onRetry} isEmpty emptyMessage="Nothing">
        <span>Body</span>
      </TabPanel>,
    );
    expect(screen.getByRole('alert').textContent).toContain('common.loadError');
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <TabPanel title="T" body="flush" isEmpty emptyMessage="Nothing">
        <span>Body</span>
      </TabPanel>,
    );
    const empty = screen.getByTestId('empty-state');
    expect(empty.textContent).toBe('Nothing');
    expect(empty.className).toContain('text-center');
    // A state is padded even in a flush panel.
    expect(empty.parentElement?.className).toContain('p-6');

    rerender(
      <TabPanel title="T" isEmpty={false} emptyMessage="Nothing">
        <span>Body</span>
      </TabPanel>,
    );
    expect(screen.getByText('Body')).toBeTruthy();
  });
});

describe('content states', () => {
  it('render the loading logo, error with Retry and centered empty text', () => {
    render(
      <table>
        <tbody>
          <TableStateRow colSpan={3}>
            <LoadingState />
          </TableStateRow>
        </tbody>
      </table>,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('cell').getAttribute('colspan')).toBe('3');
    cleanup();

    render(<ErrorState />);
    expect(screen.getByRole('alert').textContent).toBe('common.loadError');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    render(<EmptyState>No rows</EmptyState>);
    expect(screen.getByText('No rows').className).toContain('text-muted-foreground');
  });
});

describe('TabsContent spacing', () => {
  it('spaces the panels of a tab in one place', () => {
    render(
      <Tabs value="a" onValueChange={() => undefined}>
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">
          <TabPanel title="A">x</TabPanel>
        </TabsContent>
      </Tabs>,
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel.className).toContain('mt-4');
    expect(panel.className).toContain('space-y-6');
  });
});
