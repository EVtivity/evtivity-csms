// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/timezone', () => ({ formatDate: (value: string) => value }));

import { DriversTable, type Driver } from '../DriversTable';
import { AccountAvatar } from '../AccountAvatar';

function driver(over: Partial<Driver>): Driver {
  return {
    id: 'drv_1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: null,
    phone: null,
    isActive: true,
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function renderTable(drivers: Driver[]): void {
  render(
    <MemoryRouter>
      <DriversTable
        drivers={drivers}
        page={1}
        totalPages={1}
        onPageChange={() => undefined}
        timezone="UTC"
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('DriversTable avatars', () => {
  it('shows a generated avatar, initials without one, and nothing for an erased driver', async () => {
    renderTable([
      driver({
        id: 'drv_1',
        avatar: { kind: 'generated', style: 'avataaars', seed: 'abc', options: {} },
      }),
      driver({ id: 'drv_2', firstName: 'Max', lastName: 'Roe', avatar: null }),
      driver({ id: 'drv_3', firstName: '', lastName: '', erasedAt: '2026-10-02T00:00:00Z' }),
    ]);
    const img = await screen.findByAltText('avatar.alt');
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
    const row2 = screen.getByTestId('driver-row-drv_2');
    expect(row2.querySelector('[role="img"]')?.textContent).toBe('MR');
    const row3 = screen.getByTestId('driver-row-drv_3');
    expect(row3.querySelector('[role="img"]')).toBeNull();
    expect(row3.querySelector('img')).toBeNull();
  });
});

describe('AccountAvatar', () => {
  it('shows an uploaded image and falls back to initials when it fails or has no URL', () => {
    render(
      <AccountAvatar
        avatar={{ kind: 'image', url: 'https://s3.example/a.jpg' }}
        firstName="Jane"
        lastName="Doe"
        size="lg"
      />,
    );
    const img = screen.getByAltText('avatar.alt');
    expect(img.getAttribute('src')).toBe('https://s3.example/a.jpg');
    fireEvent.error(img);
    expect(screen.getByRole('img').textContent).toBe('JD');
    cleanup();
    render(<AccountAvatar avatar={{ kind: 'image', url: null }} firstName="Jane" lastName="" />);
    expect(screen.getByRole('img').textContent).toBe('J');
  });

  it('shows initials for generated options off the allow-list (I3)', async () => {
    render(
      <AccountAvatar
        avatar={{
          kind: 'generated',
          style: 'avataaars',
          seed: 'abc',
          options: { topVariant: 'not-a-variant', backgroundColor: 'url(x)' },
        }}
        firstName="Jane"
        lastName="Doe"
      />,
    );
    await act(async () => {
      await import('@evtivity/lib/account-avatar');
    });
    expect(screen.getByRole('img').textContent).toBe('JD');
    expect(screen.queryByAltText('avatar.alt')).toBeNull();
  });
});
