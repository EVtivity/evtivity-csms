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

import { ApiError } from '@/lib/api';
import { TransformerForm, kvaChoiceFor, standardKvaRatings } from '../TransformerForm';
import type { TransformerItem } from '../load-management-types';

const PANELS = [
  {
    type: 'panel' as const,
    id: 'pnl_main',
    name: 'Main Switchboard',
    childPanels: [
      { type: 'panel' as const, id: 'pnl_sub', name: 'Level 2 Panel', childPanels: [] },
    ],
  },
];

const STEP_DOWN: TransformerItem = {
  id: 'tfm_sd',
  siteId: 'site1',
  kind: 'step_down',
  name: 'T2',
  ratedKva: 112.5,
  phases: 3,
  secondaryVoltageV: 120,
  powerFactor: 0.9,
  loadingLimitPercent: 80,
  safetyMarginKw: 2,
  fedFromPanelId: 'pnl_main',
  maxContinuousKw: 81,
  panelIds: [],
  sortOrder: 0,
};

function renderForm(props: Partial<Parameters<typeof TransformerForm>[0]> = {}): {
  onSaved: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransformerForm
        siteId="site1"
        panels={PANELS}
        open
        onClose={onClose}
        onSaved={onSaved}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onSaved, onClose };
}

function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('standard transformer ratings', () => {
  it('offers the pad-mount ratings for a service transformer and the dry-type list for a step-down', () => {
    expect(standardKvaRatings('service')[0]).toBe(45);
    expect(standardKvaRatings('service').at(-1)).toBe(3750);
    expect(kvaChoiceFor('service', 5000)).toBe('custom');
    expect([...standardKvaRatings('step_down')]).toEqual([75, 112.5, 150, 225, 300, 500]);
    expect(kvaChoiceFor('service', null)).toBe('');
    expect(kvaChoiceFor('service', 500)).toBe('500');
    expect(kvaChoiceFor('service', 640)).toBe('custom');
    expect(kvaChoiceFor('step_down', 45)).toBe('custom');
  });
});

describe('TransformerForm', () => {
  it('scrolls only its fields in a short viewport, so the title and Save stay in view', () => {
    renderForm();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[90dvh]');
    expect(dialog.className).not.toContain('overflow-y-auto');
    const body = dialog.querySelector('[data-dialog-body]');
    expect(body?.className).toContain('overflow-y-auto');
    // The title and the footer buttons sit outside the scrolling part.
    expect(body?.contains(dialog.querySelector('h2'))).toBe(false);
    expect(body?.contains(screen.getByRole('button', { name: /save/i }))).toBe(false);
    expect(body?.contains(dialog.querySelector('#transformer-kind'))).toBe(true);
  });

  it('creates a service transformer with the defaults and previews its capacity', async () => {
    apiMock.post.mockResolvedValue({ id: 'tfm_new' });
    const { onSaved, onClose } = renderForm();

    expect(select('transformer-kind').value).toBe('service');
    expect(input('transformer-power-factor').value).toBe('0.95');
    expect(input('transformer-loading-limit').value).toBe('100');
    // Not rated by default: no capacity yet.
    expect(screen.getByTestId('transformer-capacity').textContent).toContain(
      'loadManagement.transformerCapacityUnrated',
    );

    fireEvent.change(input('transformer-name'), { target: { value: 'Utility Transformer' } });
    fireEvent.change(select('transformer-kva'), { target: { value: '500' } });
    // 500 kVA x 0.95 x 100 % = 475 kW.
    expect(screen.getByTestId('transformer-capacity').textContent).toContain('475');
    // The step-down list is not offered for a service transformer.
    expect(select('transformer-kva').querySelector('option[value="45"]')).not.toBeNull();
    expect(document.getElementById('transformer-fed-from')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.post).toHaveBeenCalledWith('/v1/sites/site1/transformers', {
      kind: 'service',
      name: 'Utility Transformer',
      ratedKva: 500,
      phases: 3,
      secondaryVoltageV: null,
      powerFactor: 0.95,
      loadingLimitPercent: 100,
      safetyMarginKw: 0,
      fedFromPanelId: null,
    });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('takes a custom rating and refuses values outside the ranges', () => {
    renderForm();
    fireEvent.change(input('transformer-name'), { target: { value: 'T1' } });
    fireEvent.change(select('transformer-kva'), { target: { value: 'custom' } });
    fireEvent.change(input('transformer-custom-kva'), { target: { value: '640' } });
    fireEvent.change(input('transformer-power-factor'), { target: { value: '0.7' } });
    fireEvent.change(input('transformer-loading-limit'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(apiMock.post).not.toHaveBeenCalled();
    expect(screen.getByText('validation.min:{"min":0.8}')).toBeTruthy();
    expect(screen.getByText('validation.max:{"max":100}')).toBeTruthy();
  });

  it('needs the feeding panel for a step-down transformer and lists the dry-type ratings', async () => {
    apiMock.post.mockResolvedValue({ id: 'tfm_new' });
    renderForm();
    fireEvent.change(select('transformer-kind'), { target: { value: 'step_down' } });
    fireEvent.change(input('transformer-name'), { target: { value: 'T2' } });
    const kvaValues = [...select('transformer-kva').options].map((o) => o.value);
    expect(kvaValues).toEqual(['', '75', '112.5', '150', '225', '300', '500', 'custom']);
    fireEvent.change(select('transformer-kva'), { target: { value: '75' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('validation.selectRequired')).toBeTruthy();
    expect(apiMock.post).not.toHaveBeenCalled();

    // Both panels of the tree are offered, the sub-panel included.
    const fedFrom = select('transformer-fed-from');
    expect([...fedFrom.options].map((o) => o.value)).toEqual(['', 'pnl_main', 'pnl_sub']);
    fireEvent.change(fedFrom, { target: { value: 'pnl_main' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.post.mock.calls[0]?.[1]).toMatchObject({
      kind: 'step_down',
      ratedKva: 75,
      fedFromPanelId: 'pnl_main',
    });
  });

  it('keeps a standard rating the new kind does not list as a custom value', () => {
    renderForm();
    fireEvent.change(select('transformer-kva'), { target: { value: '1000' } });
    fireEvent.change(select('transformer-kind'), { target: { value: 'step_down' } });
    expect(select('transformer-kva').value).toBe('custom');
    expect(input('transformer-custom-kva').value).toBe('1000');
  });

  it('loads an existing transformer and saves it with PATCH', async () => {
    apiMock.patch.mockResolvedValue({ id: 'tfm_sd' });
    renderForm({ transformer: STEP_DOWN });
    expect(select('transformer-kind').value).toBe('step_down');
    expect(select('transformer-kva').value).toBe('112.5');
    expect(select('transformer-voltage').value).toBe('120');
    expect(select('transformer-fed-from').value).toBe('pnl_main');
    // 112.5 kVA x 0.9 x 80 % = 81 kW.
    expect(screen.getByTestId('transformer-capacity').textContent).toContain('81');

    fireEvent.change(input('transformer-name'), { target: { value: 'T2 Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.patch.mock.calls[0]?.[0]).toBe('/v1/sites/site1/transformers/tfm_sd');
    expect(apiMock.patch.mock.calls[0]?.[1]).toMatchObject({
      name: 'T2 Renamed',
      ratedKva: 112.5,
      powerFactor: 0.9,
      loadingLimitPercent: 80,
      safetyMarginKw: 2,
    });
  });

  it('shows the server error and marks the refused field', async () => {
    apiMock.post.mockRejectedValue(
      new ApiError(400, {
        error: 'A step-down transformer needs a feeding panel of the site',
        code: 'VALIDATION_ERROR',
        field: 'fedFromPanelId',
      }),
    );
    renderForm();
    fireEvent.change(select('transformer-kind'), { target: { value: 'step_down' } });
    fireEvent.change(input('transformer-name'), { target: { value: 'T2' } });
    fireEvent.change(select('transformer-fed-from'), { target: { value: 'pnl_sub' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(
      await screen.findByText('A step-down transformer needs a feeding panel of the site'),
    ).toBeTruthy();
    expect(select('transformer-fed-from').className).toContain('border-destructive');
  });
});
