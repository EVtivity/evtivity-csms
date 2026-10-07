// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { PermissionEditor, type PermissionGroup } from '../PermissionEditor';

const GROUPS: PermissionGroup[] = [
  {
    resource: 'stations',
    kind: 'page',
    labelKey: 'users.permissionGroups.stations',
    permissions: ['stations:read', 'stations:write'],
  },
  {
    resource: 'settings.payment',
    kind: 'settings',
    labelKey: 'users.permissionGroups.settings.payment',
    permissions: ['settings.payment:read', 'settings.payment:write'],
  },
];

function renderEditor(value: string[], onChange = vi.fn()): ReturnType<typeof vi.fn> {
  getMock.mockResolvedValue(GROUPS);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PermissionEditor value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('PermissionEditor', () => {
  afterEach(() => {
    cleanup();
    getMock.mockReset();
  });

  it('translates group labels and the read and write labels', async () => {
    renderEditor([]);
    expect(await screen.findByText('t:users.permissionGroups.stations')).toBeTruthy();
    expect(screen.getByText('t:users.permissionGroups.settings.payment')).toBeTruthy();
    expect(screen.getAllByText('t:users.permissionRead')).toHaveLength(2);
    expect(screen.getAllByText('t:users.permissionWrite')).toHaveLength(2);
  });

  it('puts page groups under Pages and settings groups under Settings by kind', async () => {
    renderEditor([]);
    const pages = (await screen.findByText('t:users.pagePermissions')).parentElement;
    const settings = screen.getByText('t:users.settingsPermissions').parentElement;
    expect(pages?.textContent).toContain('t:users.permissionGroups.stations');
    expect(pages?.textContent).not.toContain('settings.payment');
    expect(settings?.textContent).toContain('t:users.permissionGroups.settings.payment');
    expect(settings?.textContent).not.toContain('permissionGroups.stations');
  });

  it('selects read with write', async () => {
    const onChange = renderEditor([]);
    fireEvent.click(
      await screen.findByLabelText('t:users.permissionWrite', {
        selector: '#perm-stations\\:write',
      }),
    );
    expect(onChange).toHaveBeenCalledWith(['stations:write', 'stations:read']);
  });
});
