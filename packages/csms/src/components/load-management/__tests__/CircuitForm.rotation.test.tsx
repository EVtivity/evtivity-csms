// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/saved-message', () => ({ useSavedToast: () => () => undefined }));

import { CircuitForm } from '../CircuitForm';

const CIRCUIT = {
  id: 'cir_1',
  name: 'Bay 1',
  breakerRatingAmps: 32,
  maxContinuousKw: 17.6,
  currentDrawKw: 0,
  availableKw: 17.6,
  phaseConnections: null,
  voltageV: null,
  phaseRotation: 'TRS',
  stations: [],
  unmanagedLoads: [],
};

function renderForm(panelPhases: number, circuit?: typeof CIRCUIT): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CircuitForm
        siteId="sit_1"
        panelId="pnl_1"
        panelVoltageV={230}
        panelPhases={panelPhases}
        {...(circuit != null ? { circuit } : {})}
        open
        onClose={() => undefined}
        onSaved={() => undefined}
      />
    </QueryClientProvider>,
  );
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CircuitForm phase rotation', () => {
  it('names the panel phase of each station phase in every option', () => {
    renderForm(3);
    const select = screen.getByLabelText('loadManagement.phaseRotation');
    const trs = Array.from((select as HTMLSelectElement).options).find((o) => o.value === 'TRS');
    expect(trs?.textContent).toBe(
      'loadManagement.phaseRotationOption:{"rotation":"TRS","l1":"L3","l2":"L1","l3":"L2"}',
    );
    expect((select as HTMLSelectElement).options[0]?.textContent).toBe(
      'loadManagement.phaseRotationReported',
    );
  });

  it('shows no rotation on a single-phase panel or a circuit on fewer phases', () => {
    renderForm(1);
    expect(screen.queryByLabelText('loadManagement.phaseRotation')).toBeNull();
    cleanup();
    renderForm(3);
    fireEvent.change(screen.getByLabelText('loadManagement.phaseConnections'), {
      target: { value: 'L1L2' },
    });
    expect(screen.queryByLabelText('loadManagement.phaseRotation')).toBeNull();
  });

  it('sends the picked rotation on create and leaves it out when reported', async () => {
    apiMock.post.mockResolvedValue({});
    renderForm(3);
    fireEvent.change(screen.getByLabelText('loadManagement.circuitName'), {
      target: { value: 'C' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.post.mock.calls[0]?.[1]).not.toHaveProperty('phaseRotation');

    cleanup();
    renderForm(3);
    fireEvent.change(screen.getByLabelText('loadManagement.circuitName'), {
      target: { value: 'C' },
    });
    fireEvent.change(screen.getByLabelText('loadManagement.phaseRotation'), {
      target: { value: 'STR' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(2);
    });
    expect(apiMock.post.mock.calls[1]?.[1]).toMatchObject({ phaseRotation: 'STR' });
  });

  it('sends null on edit when the circuit moves to fewer phases', async () => {
    apiMock.patch.mockResolvedValue({});
    renderForm(3, CIRCUIT);
    expect(screen.getByLabelText<HTMLSelectElement>('loadManagement.phaseRotation').value).toBe(
      'TRS',
    );
    fireEvent.change(screen.getByLabelText('loadManagement.phaseConnections'), {
      target: { value: 'L1' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.patch.mock.calls[0]?.[1]).toMatchObject({
      phaseConnections: 'L1',
      phaseRotation: null,
    });
  });
});
