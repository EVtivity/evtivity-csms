// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const { permission } = vi.hoisted(() => ({ permission: { granted: true } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.granted }));
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});

import { AuditEntryDialog } from '../AuditEntryDialog';
import type { AuditEntry } from '@/components/EntityHistoryTab';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    entityType: 'site',
    entityId: 'sit_1',
    entityIdSnapshot: 'sit_1',
    action: 'updated',
    actor: 'operator',
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
    actorName: 'Ada Admin',
    before: { name: 'Old', city: 'Berlin', secret: '<redacted>' },
    after: { name: 'New', city: 'Berlin', secret: '<redacted>', meta: { a: [1] } },
    notes: null,
    viaAi: null,
    createdAt: '2026-10-14T10:00:00.000Z',
    ...over,
  };
}

const onOpenChange = vi.fn();

function renderDialog(e: AuditEntry): void {
  render(
    <MemoryRouter initialEntries={['/audit']}>
      <Routes>
        <Route path="/audit" element={<AuditEntryDialog entry={e} onOpenChange={onOpenChange} />} />
        <Route path="/sites/:id" element={<p>site page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  onOpenChange.mockReset();
  permission.granted = true;
});

afterEach(() => {
  cleanup();
});

describe('AuditEntryDialog', () => {
  it('renders nothing without an entry', () => {
    render(
      <MemoryRouter>
        <AuditEntryDialog entry={null} onOpenChange={onOpenChange} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the changed fields only, and the rest on the toggle', () => {
    renderDialog(entry());
    expect(screen.getByTestId('audit-field-name')).toBeTruthy();
    expect(screen.getByTestId('audit-field-meta.a')).toBeTruthy();
    expect(screen.queryByTestId('audit-field-city')).toBeNull();
    fireEvent.click(screen.getByText('audit.showUnchanged'));
    expect(screen.getByTestId('audit-field-city')).toBeTruthy();
    expect(screen.getByTestId('audit-field-secret').textContent).toContain('audit.redacted');
    expect(screen.getByText('audit.hideUnchanged')).toBeTruthy();
  });

  it('shows a created row with After only', () => {
    renderDialog(entry({ action: 'created', before: null, after: { name: 'A' } }));
    expect(screen.queryByText('audit.before')).toBeNull();
    expect(screen.getByText('audit.after')).toBeTruthy();
    expect(screen.getByTestId('audit-field-name')).toBeTruthy();
    expect(screen.queryByText('audit.showUnchanged')).toBeNull();
  });

  it('shows a deleted entity with Before only and no Go to Entity', () => {
    renderDialog(entry({ action: 'deleted', entityId: null, after: null }));
    expect(screen.getByText('audit.before')).toBeTruthy();
    expect(screen.queryByText('audit.after')).toBeNull();
    expect(screen.getByTestId('audit-entity-deleted')).toBeTruthy();
    expect(screen.queryByText('audit.goToEntity')).toBeNull();
  });

  it('says so when nothing changed', () => {
    renderDialog(entry({ before: null, after: null }));
    expect(screen.getByTestId('audit-no-changes')).toBeTruthy();
  });

  it('opens the entity page with Go to Entity', () => {
    renderDialog(entry());
    fireEvent.click(screen.getByText('audit.goToEntity'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByText('site page')).toBeTruthy();
  });

  it('hides Go to Entity without the page permission and for a type without a page', () => {
    permission.granted = false;
    renderDialog(entry());
    expect(screen.queryByText('audit.goToEntity')).toBeNull();
    cleanup();
    permission.granted = true;
    renderDialog(entry({ entityType: 'role', entityId: 'rol_1' }));
    expect(screen.queryByText('audit.goToEntity')).toBeNull();
  });

  it('names the AI channel of a change made through the assistant', () => {
    renderDialog(entry({ viaAi: { channel: 'chat', conversationId: 'aic_1' } }));
    expect(screen.getByTestId('audit-via-ai').textContent).toContain('aic_1');
  });

  it('wraps a long value inside the dialog instead of widening the Changes table', () => {
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    renderDialog(entry({ before: null, after: { userAgent } }));
    // The DialogContent grid item would otherwise grow to the table's widest line.
    expect(screen.getByTestId('audit-changes').className).toContain('min-w-0');
    const row = screen.getByTestId('audit-field-userAgent');
    const cells = row.querySelectorAll('td');
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      // TableCell defaults to whitespace-nowrap, which keeps wrap-anywhere from breaking.
      expect(cell.className).toContain('whitespace-normal');
      expect(cell.className).toContain('wrap-anywhere');
      expect(cell.className).not.toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
    }
    expect(cells[1]?.textContent).toBe(userAgent);
  });
});
