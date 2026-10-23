// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super('api');
    }
  },
}));

// The proof field: a stand-in that reports a password proof when its button is pressed.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({ onChange }: { onChange: (p: unknown) => void }) => (
    <button
      type="button"
      onClick={() => {
        onChange({ kind: 'password', password: 'secret' });
      }}
    >
      give-proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { SecuritySsoSettings } from '../SecuritySsoSettings';

const STORED = {
  'sso.enabled': true,
  'sso.provider': 'okta',
  'sso.entryPoint': 'https://idp.example.com/sso',
  'sso.issuer': 'evtivity-csms',
  'sso.certEnc': 'CERT-ONE',
  'sso.autoProvision': false,
  'sso.defaultRoleId': '',
  'sso.attributeMapping': '{"email":"email","firstName":"firstName","lastName":"lastName"}',
};

beforeEach(() => {
  api.get.mockImplementation((url: string) => {
    if (url === '/v1/users/me/mfa') {
      return Promise.resolve({ factorProofKinds: ['password'], mfaMethod: null });
    }
    if (url === '/v1/sso/settings') return Promise.resolve(STORED);
    return Promise.resolve([]);
  });
  api.put.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SecuritySsoSettings settings={undefined} />
    </QueryClientProvider>,
  );
}

describe('SecuritySsoSettings', () => {
  it('saves the provider hint alone without a proof', async () => {
    renderForm();
    await screen.findByDisplayValue('https://idp.example.com/sso');
    expect(screen.queryByText('give-proof')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.put).toHaveBeenCalled();
    });
    const body = api.put.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['proof']).toBeUndefined();
    expect(body['cert']).toBeUndefined();
  });

  it('asks for the proof when the identity provider changes and sends it', async () => {
    renderForm();
    const entry = await screen.findByDisplayValue('https://idp.example.com/sso');
    fireEvent.change(entry, { target: { value: 'https://idp2.example.com/sso' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('give-proof'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.put).toHaveBeenCalled();
    });
    const body = api.put.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['entryPoint']).toBe('https://idp2.example.com/sso');
    expect(body['proof']).toEqual({ kind: 'password', password: 'secret' });
  });
});
