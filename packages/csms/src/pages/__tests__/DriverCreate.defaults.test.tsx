// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

// The New Driver page preselects the language, timezone and distance unit of
// Settings > Company (GET /v1/drivers/defaults); a value the user picks wins.

const { getMock, postMock, navigateMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigateMock,
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), delete: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/avatar/PendingAvatarField', () => ({ PendingAvatarField: () => null }));

import { DriverCreate } from '../DriverCreate';

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DriverCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fill(): void {
  fireEvent.change(screen.getByLabelText('drivers.firstName'), { target: { value: 'Ana' } });
  fireEvent.change(screen.getByLabelText('drivers.lastName'), { target: { value: 'Lee' } });
  fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'ana@b.example' } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('New Driver defaults', () => {
  it('preselects and sends the company defaults', async () => {
    getMock.mockResolvedValue({ timezone: 'Europe/Berlin', distanceUnit: 'km', language: 'de' });
    postMock.mockResolvedValue({ id: 'drv_new' });
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('drivers.language').value).toBe('de');
    });
    expect(getMock).toHaveBeenCalledWith('/v1/drivers/defaults');
    expect(screen.getByLabelText<HTMLSelectElement>('drivers.timezone').value).toBe(
      'Europe/Berlin',
    );
    expect(screen.getByLabelText<HTMLSelectElement>('drivers.distanceUnit').value).toBe('km');

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/drivers', {
        firstName: 'Ana',
        lastName: 'Lee',
        email: 'ana@b.example',
        language: 'de',
        timezone: 'Europe/Berlin',
        distanceUnit: 'km',
      });
    });
  });

  it('sends the values the user picks over the defaults', async () => {
    getMock.mockResolvedValue({ timezone: 'Europe/Berlin', distanceUnit: 'km', language: 'de' });
    postMock.mockResolvedValue({ id: 'drv_new' });
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('drivers.language').value).toBe('de');
    });

    fill();
    fireEvent.change(screen.getByLabelText('drivers.language'), { target: { value: 'ko' } });
    fireEvent.change(screen.getByLabelText('drivers.timezone'), {
      target: { value: 'Asia/Seoul' },
    });
    fireEvent.change(screen.getByLabelText('drivers.distanceUnit'), {
      target: { value: 'miles' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/drivers',
        expect.objectContaining({ language: 'ko', timezone: 'Asia/Seoul', distanceUnit: 'miles' }),
      );
    });
  });
});
