// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const h = vi.hoisted(() => ({ permissions: new Set<string>(), allSites: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => h.permissions.has(permission),
  useHasAllSiteAccess: () => h.allSites,
}));
vi.mock('@/components/EntityHistoryTab', () => ({
  EntityHistoryTab: ({ entityType, entityId }: { entityType: string; entityId: string | null }) => (
    <div data-testid="entity-history">{`${entityType}:${entityId ?? '*'}`}</div>
  ),
}));
vi.mock('@/components/reports/GenerateTab', () => ({ GenerateTab: () => null }));
vi.mock('@/components/reports/GeneratedReportsTab', () => ({
  GeneratedReportsTab: () => <div data-testid="generated-reports" />,
}));
vi.mock('@/components/reports/SchedulesTab', () => ({ SchedulesTab: () => null }));
vi.mock('@/components/reports/NeviComplianceTab', () => ({ NeviComplianceTab: () => null }));
vi.mock('@/components/reports/SustainabilityTab', () => ({ SustainabilityTab: () => null }));
vi.mock('@/pages/OcppEvents', () => ({ OcppEvents: () => null }));
vi.mock('@/pages/DriverEvents', () => ({ DriverEvents: () => null }));
vi.mock('@/pages/SystemEvents', () => ({ SystemEvents: () => null }));
vi.mock('@/pages/NotificationHistory', () => ({
  NotificationHistory: () => <div data-testid="sent-notifications" />,
}));

import { Reports } from '../Reports';
import { NotificationRules } from '../NotificationRules';

function renderAt(path: string, page: React.JSX.Element): void {
  render(<MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>);
}

function historyTabs(): HTMLElement[] {
  return screen.queryAllByRole('tab').filter((tab) => tab.textContent === 'audit.history');
}

beforeEach(() => {
  h.permissions = new Set(['audit:read']);
  h.allSites = true;
});

afterEach(() => {
  cleanup();
});

describe('Reports page', () => {
  it('lists generated reports under their own tab, not History', () => {
    renderAt('/reports?tab=generated', <Reports />);
    expect(screen.getByRole('tab', { name: 'reports.generatedReportsTab' })).toBeTruthy();
    expect(screen.getByTestId('generated-reports')).toBeTruthy();
  });

  it('has one History tab listing report schedule changes and report deletes', () => {
    renderAt('/reports?tab=history', <Reports />);
    expect(historyTabs()).toHaveLength(1);
    expect(screen.getAllByTestId('entity-history').map((e) => e.textContent)).toEqual([
      'report_schedule:*',
    ]);
  });

  it('hides History without audit:read', () => {
    h.permissions = new Set();
    renderAt('/reports', <Reports />);
    expect(historyTabs()).toHaveLength(0);
  });
});

describe('Notifications page', () => {
  it('lists sent notifications under their own tab, not History', () => {
    renderAt('/notifications?tab=sent', <NotificationRules />);
    expect(screen.getByRole('tab', { name: 'notifications.sentNotificationsTab' })).toBeTruthy();
    expect(screen.getByTestId('sent-notifications')).toBeTruthy();
  });

  it('has one History tab listing notification template changes', () => {
    renderAt('/notifications?tab=history', <NotificationRules />);
    expect(historyTabs()).toHaveLength(1);
    expect(screen.getAllByTestId('entity-history').map((e) => e.textContent)).toEqual([
      'notification_template:*',
    ]);
  });
});
