// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { permissionCatalog } from '@evtivity/lib/permissions';

const { getMock } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return { getMock: vi.fn() };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/hooks/use-event-stream', () => ({ useEventStream: () => undefined }));
vi.mock('@/components/AiAssistant', () => ({ AiAssistant: () => null }));
vi.mock('@/components/layout/UserDropdown', () => ({ UserDropdown: () => null }));

import { Layout } from '../Layout';
import { useAuth } from '@/lib/auth';

type Settings = Record<string, unknown> | undefined;

// The nav as it was before the entry list: every route in sidebar order.
const ALL_ROUTES = [
  ['/', 'dashboard:read'],
  ['/sites', 'sites:read'],
  ['/stations', 'stations:read'],
  ['/sessions', 'sessions:read'],
  ['/reservations', 'reservations:read'],
  ['/drivers', 'drivers:read'],
  ['/fleets', 'fleets:read'],
  ['/tokens', 'drivers:read'],
  ['/pricing', 'pricing:read'],
  ['/reports', 'reports:read'],
  ['/roaming', 'roaming:read'],
  ['/certificates', 'certificates:read'],
  ['/users', 'users:read'],
  ['/support-cases', 'support:read'],
  ['/notifications', 'notifications:read'],
  ['/logs', 'logs:read'],
  ['/audit', 'audit:read'],
  ['/settings', null],
] as const;

function has(perms: string[], required: string): boolean {
  return perms.includes(required) || perms.includes(required.replace(/:read$/, ':write'));
}

/** The filter Layout applied before the nav became an entry list. */
function expectedNav(settings: Settings, perms: string[]): string[] {
  const roaming = settings != null && settings['roaming.enabled'] === true;
  const pnc = settings != null && settings['pnc.enabled'] === true;
  const reservation = settings == null || settings['reservation.enabled'] !== false;
  const support = settings == null || settings['support.enabled'] !== false;
  const fleet = settings == null || settings['fleet.enabled'] !== false;
  const settingsReads = permissionCatalog
    .groups()
    .filter((g) => g.kind === 'settings')
    .map((g) => `${g.resource}:read`);
  return ALL_ROUTES.filter(([to, required]) => {
    if (to === '/roaming' && !roaming) return false;
    if (to === '/certificates' && !pnc) return false;
    if (to === '/reservations' && !reservation) return false;
    if (to === '/support-cases' && !support) return false;
    if (to === '/fleets' && !fleet) return false;
    if (to === '/settings') return settingsReads.some((p) => has(perms, p));
    return has(perms, required);
  }).map(([to]) => to);
}

const FLAG_KEYS = [
  'roaming.enabled',
  'pnc.enabled',
  'reservation.enabled',
  'support.enabled',
  'fleet.enabled',
] as const;

// Every on/off combination of the five flags, plus no flags stored and no
// answer at all (the request failed). The nav must equal the one Layout built
// from GET /v1/settings before it read the public features endpoint.
const SETTINGS_CASES: { name: string; settings: Settings }[] = [
  { name: 'settings unavailable', settings: undefined },
  { name: 'no flags stored', settings: {} },
  ...Array.from({ length: 2 ** FLAG_KEYS.length }, (_, mask) => {
    const settings: Record<string, unknown> = {};
    FLAG_KEYS.forEach((key, i) => {
      settings[key] = (mask & (1 << i)) !== 0;
    });
    return { name: FLAG_KEYS.map((k) => `${k}=${String(settings[k])}`).join(' '), settings };
  }),
];

const ALL = permissionCatalog.all();
const PERMISSION_CASES: { name: string; perms: string[] }[] = [
  { name: 'none', perms: [] },
  { name: 'every read', perms: ALL.filter((p) => p.endsWith(':read')) },
  { name: 'every write', perms: ALL.filter((p) => p.endsWith(':write')) },
  { name: 'operator', perms: permissionCatalog.defaultsFor('operator') },
  {
    name: 'mixed',
    perms: [
      'sites:write',
      'drivers:read',
      'reports:read',
      'roaming:write',
      'support:read',
      'settings.payment:write',
    ],
  },
];

function navHrefs(container: HTMLElement): string[] {
  const nav = container.querySelector('nav');
  if (nav == null) throw new Error('no nav rendered');
  return Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

/** What `GET /v1/portal/features` answers for these stored settings. */
function featuresFor(settings: Record<string, unknown>): Record<string, boolean> {
  return {
    roamingEnabled: settings['roaming.enabled'] === true,
    pncEnabled: settings['pnc.enabled'] === true,
    reservationEnabled: settings['reservation.enabled'] !== false,
    supportEnabled: settings['support.enabled'] !== false,
    fleetEnabled: settings['fleet.enabled'] !== false,
  };
}

async function renderLayout(
  settings: Settings,
  branding: Record<string, string> = {},
): Promise<HTMLElement> {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/portal/features') {
      return settings == null
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve(featuresFor(settings));
    }
    if (url === '/v1/portal/branding') return Promise.resolve(branding);
    if (url === '/v1/support-cases/unread-count') return Promise.resolve({ count: 0 });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Layout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(client.isFetching()).toBe(0);
    expect(getMock).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  useAuth.setState({ permissions: [] });
});

describe('Layout navigation', () => {
  it.each(SETTINGS_CASES)('matches the previous nav with $name', async ({ settings }) => {
    for (const { name, perms } of PERMISSION_CASES) {
      useAuth.setState({ permissions: perms });
      const container = await renderLayout(settings);
      expect(navHrefs(container), name).toEqual(expectedNav(settings, perms));
      cleanup();
      getMock.mockReset();
    }
  });

  it('never reads the settings API, which needs settings.system:read', async () => {
    useAuth.setState({ permissions: ['dashboard:read', 'roaming:read'] });
    const container = await renderLayout({ 'roaming.enabled': true });
    expect(navHrefs(container)).toEqual(['/', '/roaming']);
    expect(getMock.mock.calls.map((call) => String(call[0]))).not.toContain('/v1/settings');
  });

  it('shows the company name, logo and favicon from the public branding', async () => {
    useAuth.setState({ permissions: ['dashboard:read'] });
    const container = await renderLayout(
      {},
      { name: 'Acme Charging', logo: 'https://example.com/logo.png', favicon: '/acme.ico' },
    );
    expect(container.textContent).toContain('Acme Charging');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/logo.png',
    );
    expect(document.title).toBe('Acme Charging CSMS');
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/acme.ico');
  });

  it('falls back to EVtivity when no company name is set', async () => {
    useAuth.setState({ permissions: ['dashboard:read'] });
    const container = await renderLayout({});
    expect(container.textContent).toContain('EVtivity');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/evtivity-logo-animated.svg');
    expect(document.title).toBe('EVtivity CSMS');
  });

  it('covers every nav route in some case', () => {
    const seen = new Set<string>();
    for (const { settings } of SETTINGS_CASES) {
      for (const { perms } of PERMISSION_CASES) {
        for (const to of expectedNav(settings, perms)) seen.add(to);
      }
    }
    expect([...seen].sort()).toEqual(ALL_ROUTES.map(([to]) => to).sort());
  });
});
