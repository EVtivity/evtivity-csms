// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-entity-neighbors', () => ({
  useEntityNeighbors: (_resource: string, id: string | undefined) =>
    id === 'a' ? { prevId: null, nextId: 'b' } : { prevId: 'a', nextId: null },
}));

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { EntityNavButtons } from '../entity-nav-buttons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { useTab } from '@/hooks/use-tab';

afterEach(() => {
  cleanup();
});

/** A detail page whose record `b` lacks the `events` tab (like a 1.6 station). */
function DetailPage(): React.JSX.Element {
  const { id } = useParams();
  const [tab, setTab] = useTab('info');
  return (
    <div>
      <EntityNavButtons resource="stations" basePath="/stations" currentId={id} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          {id === 'a' && <TabsTrigger value="events">Events</TabsTrigger>}
        </TabsList>
        <TabsContent value="info">info panel {id}</TabsContent>
        <TabsContent value="logs">logs panel {id}</TabsContent>
        <TabsContent value="events">events panel {id}</TabsContent>
      </Tabs>
    </div>
  );
}

function renderAt(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/stations/:id" element={<DetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function clickNav(name: string): void {
  const button = screen.getByRole('button', { name });
  const link = button.closest('a');
  if (link == null) throw new Error(`${name} has no link`);
  fireEvent.click(link);
}

describe('Prev and Next keep the open tab (ISSUES item 6)', () => {
  it('links the neighbor with the current tab', () => {
    renderAt('/stations/a?tab=logs');
    const link = screen.getByRole('button', { name: 'common.next' }).closest('a');
    expect(link?.getAttribute('href')).toBe('/stations/b?tab=logs');
  });

  it('links the neighbor without a tab on the default tab', () => {
    renderAt('/stations/a');
    const link = screen.getByRole('button', { name: 'common.next' }).closest('a');
    expect(link?.getAttribute('href')).toBe('/stations/b');
  });

  it('shows the same tab on the next record', () => {
    renderAt('/stations/a?tab=logs');
    expect(screen.getByText('logs panel a')).toBeTruthy();
    clickNav('common.next');
    expect(screen.getByText('logs panel b')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows the first tab on a record without the open tab, and the tab again on one with it', () => {
    renderAt('/stations/a?tab=events');
    expect(screen.getByText('events panel a')).toBeTruthy();
    clickNav('common.next');
    expect(screen.queryByText('events panel b')).toBeNull();
    expect(screen.getByText('info panel b')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true');
    clickNav('common.prev');
    expect(screen.getByText('events panel a')).toBeTruthy();
  });
});
