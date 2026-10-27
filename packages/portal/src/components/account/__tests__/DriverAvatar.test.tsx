// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { DriverAvatar } from '../DriverAvatar';
import { initialsOf } from '@/lib/avatar';

afterEach(cleanup);

describe('DriverAvatar', () => {
  it('shows initials without an avatar', () => {
    render(<DriverAvatar avatar={null} firstName="ana" lastName="Lee" />);
    expect(screen.getByRole('img').textContent).toBe('AL');
  });

  it('renders a generated avatar as an SVG data URI image', async () => {
    render(
      <DriverAvatar
        avatar={{
          kind: 'generated',
          style: 'avataaars',
          seed: 'abc',
          options: { topVariant: 'bob' },
          updatedAt: null,
        }}
        firstName="Ana"
      />,
    );
    const img = await screen.findByAltText('account.avatarAlt');
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('shows initials for generated options off the allow-list (I3)', async () => {
    render(
      <DriverAvatar
        avatar={{
          kind: 'generated',
          style: 'avataaars',
          seed: 'abc',
          options: { topVariant: 'not-a-variant' },
          updatedAt: null,
        }}
        firstName="Ana"
        lastName="Lee"
      />,
    );
    await act(async () => {
      await import('@evtivity/lib/account-avatar');
    });
    expect(screen.getByRole('img').textContent).toBe('AL');
    expect(screen.queryByAltText('account.avatarAlt')).toBeNull();
  });

  it('shows the image and falls back to initials when it fails to load', () => {
    render(
      <DriverAvatar
        avatar={{
          kind: 'image',
          url: 'https://s3.example/a.jpg',
          expiresAt: null,
          updatedAt: null,
        }}
        firstName="Ana"
        lastName="Lee"
      />,
    );
    const img = screen.getByAltText('account.avatarAlt');
    expect(img.getAttribute('src')).toBe('https://s3.example/a.jpg');
    fireEvent.error(img);
    expect(screen.getByRole('img').textContent).toBe('AL');
  });

  it('shows initials for an image whose storage is gone (null URL)', () => {
    render(
      <DriverAvatar
        avatar={{ kind: 'image', url: null, expiresAt: null, updatedAt: null }}
        firstName="Ana"
      />,
    );
    expect(screen.getByRole('img').textContent).toBe('A');
  });
});

describe('avatar helpers', () => {
  it('makes initials', () => {
    expect(initialsOf(' ana ', null)).toBe('A');
    expect(initialsOf('', '')).toBe('');
  });
});
