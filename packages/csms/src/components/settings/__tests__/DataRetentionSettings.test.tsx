// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import {
  DATA_RETENTION_GROUPS,
  DATA_RETENTION_KEYS,
  DATA_RETENTION_SETTINGS,
} from '@evtivity/lib/data-retention';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
// The proof field has its own tests: here it hands back a password proof.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({
    onChange,
    showMissing,
  }: {
    onChange: (proof: { kind: string; password: string }) => void;
    showMissing: boolean;
  }) => (
    <button
      type="button"
      data-testid="retention-proof"
      data-missing={String(showMissing)}
      onClick={() => {
        onChange({ kind: 'password', password: 'pw' });
      }}
    >
      proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { DataRetentionLink, DataRetentionSettings } from '../DataRetentionSettings';

const DEFAULTS = Object.fromEntries(
  DATA_RETENTION_KEYS.map((key) => [key, DATA_RETENTION_SETTINGS[key].defaultDays]),
);

function renderTab(
  canWrite: boolean,
  data: Record<string, number> = DEFAULTS,
  proofKinds: string[] | null = null,
): void {
  apiMock.get.mockImplementation((url: string) =>
    url === '/v1/settings/data-retention'
      ? Promise.resolve(data)
      : url === '/v1/users/me/mfa' && proofKinds != null
        ? Promise.resolve({ factorProofKinds: proofKinds, mfaMethod: null })
        : Promise.reject(new Error(`unexpected ${url}`)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DataRetentionSettings canWrite={canWrite} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('DataRetentionSettings', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.put.mockReset();
    apiMock.put.mockImplementation((_url: string, body: Record<string, number>) =>
      Promise.resolve({ ...DEFAULTS, ...body }),
    );
  });
  afterEach(() => {
    cleanup();
  });

  it('shows one card per group, every setting and the storage warning', async () => {
    renderTab(true);
    expect(await screen.findByTestId('data-retention-operationalLogs')).toBeTruthy();
    for (const group of DATA_RETENTION_GROUPS) {
      expect(screen.getByText(`settings.dataRetention.groups.${group}`)).toBeTruthy();
    }
    expect(screen.getAllByRole('spinbutton')).toHaveLength(DATA_RETENTION_KEYS.length);
    expect(screen.getByTestId('data-retention-storage-warning')).toBeTruthy();
    const ocpp = screen.getByLabelText<HTMLInputElement>(
      'settings.dataRetention.rows.ocppMessage.label',
    );
    expect(ocpp.value).toBe('30');
    // 0 keeps forever only where the job supports it.
    expect(
      screen.getAllByText(
        (_, el) =>
          (el?.id ?? '').endsWith('-hint') && (el?.textContent ?? '').includes('keepForever'),
      ),
    ).toHaveLength(
      DATA_RETENTION_KEYS.filter((k) => DATA_RETENTION_SETTINGS[k].keepForever).length,
    );
  });

  it('saves only the changed keys', async () => {
    renderTab(true);
    const ocpp = await screen.findByLabelText('settings.dataRetention.rows.ocppMessage.label');
    fireEvent.change(ocpp, { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('settings.dataRetention.rows.meterValues.label'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/data-retention', {
        'logs.ocppMessage.retentionDays': 7,
        'logs.meterValues.retentionDays': 0,
      });
    });
  });

  it('asks for a proof to shorten the audit history and sends it', async () => {
    renderTab(true, DEFAULTS, ['password']);
    const audit = await screen.findByLabelText('settings.dataRetention.rows.audit.label');
    // Lengthening needs no proof.
    fireEvent.change(audit, { target: { value: '2000' } });
    expect(screen.queryByTestId('retention-proof')).toBeNull();

    fireEvent.change(audit, { target: { value: '30' } });
    const proofField = await screen.findByTestId('retention-proof');
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(screen.getByTestId('retention-proof').getAttribute('data-missing')).toBe('true');
    });
    expect(apiMock.put).not.toHaveBeenCalled();

    fireEvent.click(proofField);
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/data-retention', {
        'audit.retentionDays': 30,
        proof: { kind: 'password', password: 'pw' },
      });
    });
  });

  it('refuses a value out of range before sending', async () => {
    renderTab(true);
    const sim = await screen.findByLabelText('settings.dataRetention.rows.simSessions.label');
    fireEvent.change(sim, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    expect(await screen.findByText('validation.min {"min":7}')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('saves another setting while a stored value is outside its range', async () => {
    renderTab(true, { ...DEFAULTS, 'logs.access.retentionDays': 5000 });
    const ocpp = await screen.findByLabelText('settings.dataRetention.rows.ocppMessage.label');
    fireEvent.change(ocpp, { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/data-retention', {
        'logs.ocppMessage.retentionDays': 14,
      });
    });
  });

  it('is read-only without write access', async () => {
    renderTab(false);
    const ocpp = await screen.findByLabelText<HTMLInputElement>(
      'settings.dataRetention.rows.ocppMessage.label',
    );
    expect(ocpp.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /common.save/ })).toBeNull();
  });

  it('links moved inputs to the tab', () => {
    render(
      <MemoryRouter>
        <DataRetentionLink />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings?tab=dataRetention');
  });
});
