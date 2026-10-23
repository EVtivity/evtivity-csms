// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(() => Promise.resolve({ factorProofKinds: ['password'], mfaMethod: null })),
  },
}));
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

import { SsoLinkCard } from '../SsoLinkCard';

function wrap(node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
});

describe('SsoLinkCard', () => {
  it('allows the link only with the proof', async () => {
    const allow = vi.fn(() => Promise.resolve());
    const onChanged = vi.fn();
    wrap(<SsoLinkCard linked={false} allowed={false} allow={allow} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'users.ssoLinkAllow' }));
    const confirm = screen.getAllByRole('button', { name: 'users.ssoLinkAllow' }).at(-1);
    fireEvent.click(await screen.findByText('give-proof'));
    if (confirm != null) fireEvent.click(confirm);
    await waitFor(() => {
      expect(allow).toHaveBeenCalledWith({ kind: 'password', password: 'secret' });
    });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it('shows a linked account and offers nothing', () => {
    wrap(
      <SsoLinkCard
        linked
        allowed={false}
        allow={() => Promise.resolve()}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByText('users.ssoLinked')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('removes a binding only with the proof', async () => {
    const unlink = vi.fn(() => Promise.resolve());
    wrap(
      <SsoLinkCard
        linked
        allowed={false}
        allow={() => Promise.resolve()}
        unlink={unlink}
        onChanged={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'users.ssoUnlink' }));
    fireEvent.click(await screen.findByText('give-proof'));
    const confirm = screen.getAllByRole('button', { name: 'users.ssoUnlink' }).at(-1);
    if (confirm != null) fireEvent.click(confirm);
    await waitFor(() => {
      expect(unlink).toHaveBeenCalledWith({ kind: 'password', password: 'secret' });
    });
  });
});
