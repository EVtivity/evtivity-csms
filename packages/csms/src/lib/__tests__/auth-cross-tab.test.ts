// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet, mockPost, mockPatch, mockLoadLanguage, mockApplyTheme } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockLoadLanguage: vi.fn(() => Promise.resolve()),
  mockApplyTheme: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));
vi.mock('../../i18n', () => ({ loadLanguage: mockLoadLanguage }));
vi.mock('../theme', () => ({
  applyTheme: mockApplyTheme,
  applyUiTheme: vi.fn(),
  adoptUiTheme: (value: unknown) => value ?? 'default',
  resolveInitialTheme: () => 'light',
  resolveInitialUiTheme: () => 'default',
  writeStored: (key: string, value: string) => {
    localStorage.setItem(key, value);
  },
}));

import { useAuth } from '../auth';
import { queryClient } from '../query';
import { useAiPanelStore } from '../../components/ai/use-ai-panel-store';

const otherTab = new BroadcastChannel('evtivity-csms-auth');
const sent: unknown[] = [];
otherTab.addEventListener('message', (event: MessageEvent) => {
  sent.push(event.data);
});

const admin = {
  id: 'u-admin',
  email: 'admin@x.test',
  firstName: 'Ada',
  lastName: 'Admin',
  language: 'en',
  timezone: 'UTC',
  themePreference: 'light' as const,
};

async function signInAsAdmin(): Promise<void> {
  mockPost.mockResolvedValueOnce({ user: admin, role: { id: 'r1', name: 'admin' } });
  mockGet.mockResolvedValueOnce({
    permissions: ['dashboard:read', 'fleets:read'],
    hasAllSiteAccess: true,
  });
  await useAuth.getState().login(admin.email, 'pw');
  queryClient.setQueryData(['dashboard', 'stats'], { totalStations: 12 });
  queryClient.setQueryData(['dashboard-layout'], { layout: { charts: [] }, customized: true });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('sign-in changes in another tab (SH-M19, case 461)', () => {
  beforeEach(() => {
    useAuth.setState({
      user: null,
      permissions: [],
      isAuthenticated: false,
      signedOut: false,
      isHydrating: false,
    });
    queryClient.clear();
    localStorage.clear();
    sessionStorage.clear();
    mockGet.mockReset();
    mockPost.mockReset();
    mockPost.mockResolvedValue({});
    sent.length = 0;
  });

  it('tells the other tabs who signed in and who signed out', async () => {
    await signInAsAdmin();
    await settle();
    expect(sent).toContainEqual({ type: 'signed-in', userId: admin.id });

    await useAuth.getState().logout();
    await settle();
    expect(sent).toContainEqual({ type: 'signed-out' });
  });

  it('drops the earlier user and loads the new one when another tab signs in as someone else', async () => {
    await signInAsAdmin();
    useAiPanelStore.getState().openPanel();
    mockGet.mockResolvedValueOnce({
      ...admin,
      id: 'u-fleet',
      email: 'fleet@x.test',
      role: { id: 'r2', name: 'fleet_manager' },
      permissions: ['fleets:read'],
      hasAllSiteAccess: false,
      accessScope: 'fleets',
      fleetIds: ['flt_1'],
    });

    otherTab.postMessage({ type: 'signed-in', userId: 'u-fleet' });
    await settle();

    expect(queryClient.getQueryData(['dashboard', 'stats'])).toBeUndefined();
    expect(queryClient.getQueryData(['dashboard-layout'])).toBeUndefined();
    expect(useAiPanelStore.getState().open).toBe(false);
    expect(mockGet).toHaveBeenCalledWith('/v1/users/me');
    const s = useAuth.getState();
    expect(s.user?.id).toBe('u-fleet');
    expect(s.accessScope).toBe('fleets');
    expect(s.permissions).toEqual(['fleets:read']);
  });

  it('keeps everything when another tab signs in as the same user', async () => {
    await signInAsAdmin();
    otherTab.postMessage({ type: 'signed-in', userId: admin.id });
    await settle();

    expect(queryClient.getQueryData(['dashboard', 'stats'])).toEqual({ totalStations: 12 });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('signs this tab out when another tab signs out', async () => {
    await signInAsAdmin();
    otherTab.postMessage({ type: 'signed-out' });
    await settle();

    expect(queryClient.getQueryData(['dashboard', 'stats'])).toBeUndefined();
    const s = useAuth.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.user).toBeNull();
    expect(s.permissions).toEqual([]);
    expect(s.signedOut).toBe(true);
    expect(sessionStorage.getItem('noAutoLogin')).toBe('true');
  });

  it('ignores a message that is not a sign-in change', async () => {
    await signInAsAdmin();
    otherTab.postMessage({ type: 'signed-in' });
    otherTab.postMessage('hello');
    await settle();

    expect(useAuth.getState().user?.id).toBe(admin.id);
    expect(queryClient.getQueryData(['dashboard', 'stats'])).toEqual({ totalStations: 12 });
  });
});
