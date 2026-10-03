// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return { getMock: vi.fn(), postMock: vi.fn() };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null
        ? key
        : `${key}:${Object.entries(opts)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')}`,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock },
  getApiErrorFieldDetails: () => ({}),
}));

vi.mock('@/components/GoogleMapPicker', () => ({ GoogleMapPicker: () => null }));

import { StationCreate } from '../StationCreate';

function renderCreate(): void {
  getMock.mockResolvedValue({ data: [{ id: 'sit_1', name: 'Depot' }], total: 1 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StationCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillRequired(protocol: 'ocpp1.6' | 'ocpp2.1', password: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('stations.stationId'), { target: { value: 'CS-1' } });
  await screen.findByRole('option', { name: 'Depot' });
  fireEvent.change(screen.getByLabelText('stations.site'), { target: { value: 'sit_1' } });
  fireEvent.change(screen.getByLabelText('stations.ocppProtocol'), {
    target: { value: protocol },
  });
  fireEvent.change(screen.getByLabelText('stations.password'), { target: { value: password } });
}

function submit(): void {
  const form = screen.getByLabelText('stations.stationId').closest('form');
  if (form == null) throw new Error('form not found');
  fireEvent.submit(form);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationCreate password rules', () => {
  it('shows the protocol password length in the placeholder', async () => {
    renderCreate();
    expect(screen.getByLabelText('stations.password').getAttribute('placeholder')).toBe(
      'stations.passwordPlaceholder:min=16,max=20',
    );
    fireEvent.change(screen.getByLabelText('stations.ocppProtocol'), {
      target: { value: 'ocpp2.1' },
    });
    await waitFor(() => {
      expect(screen.getByLabelText('stations.password').getAttribute('placeholder')).toBe(
        'stations.passwordPlaceholder:min=16,max=40',
      );
    });
  });

  it('rejects a password shorter than 16 characters', async () => {
    renderCreate();
    await fillRequired('ocpp2.1', 'abcdefghij');
    submit();
    expect(await screen.findByText('validation.minLength:min=16')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rejects a password longer than 20 characters on OCPP 1.6', async () => {
    renderCreate();
    await fillRequired('ocpp1.6', 'a'.repeat(21));
    submit();
    expect(await screen.findByText('validation.maxLength:max=20')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('rejects characters outside the OCPP password set', async () => {
    renderCreate();
    await fillRequired('ocpp2.1', 'abcdefghijklmnop!');
    submit();
    expect(await screen.findByText('stations.passwordInvalidCharacters')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('submits a valid OCPP 2.1 password', async () => {
    postMock.mockResolvedValue({ id: 'sta_1', stationId: 'CS-1' });
    renderCreate();
    await fillRequired('ocpp2.1', 'a'.repeat(30));
    submit();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/stations',
        expect.objectContaining({ stationId: 'CS-1', password: 'a'.repeat(30) }),
      );
    });
  });
});
