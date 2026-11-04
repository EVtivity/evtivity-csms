// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => {
  // The auth store reads the theme on import.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

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

import { PanelTree } from '../PanelTree';
import { transformerOptionsFor } from '../PanelForm';
import type { TransformerItem } from '../load-management-types';

function panel(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'panel' as const,
    id,
    name,
    breakerRatingAmps: 800,
    voltageV: 277,
    phases: 3,
    maxContinuousKw: 532,
    safetyMarginKw: 0,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    currentDrawKw: 100,
    availableKw: 432,
    utilization: 0.19,
    totalConnectedKw: 0,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    circuits: [],
    childPanels: [],
    unmanagedLoads: [],
    ...extra,
  };
}

const SERVICE: TransformerItem = {
  id: 'tfm_service',
  siteId: 'site1',
  kind: 'service',
  name: 'Utility Transformer',
  ratedKva: 500,
  phases: 3,
  secondaryVoltageV: 277,
  powerFactor: 0.95,
  loadingLimitPercent: 100,
  safetyMarginKw: 0,
  fedFromPanelId: null,
  maxContinuousKw: 475,
  panelIds: ['pnl_main'],
  sortOrder: 0,
};

const STEP_DOWN: TransformerItem = {
  ...SERVICE,
  id: 'tfm_sd',
  kind: 'step_down',
  name: 'Step Down T2',
  ratedKva: 75,
  secondaryVoltageV: 120,
  fedFromPanelId: 'pnl_main',
  maxContinuousKw: 71.25,
  panelIds: [],
};

const UNRATED: TransformerItem = {
  ...SERVICE,
  id: 'tfm_old',
  name: 'Old Transformer',
  ratedKva: null,
  maxContinuousKw: null,
  panelIds: [],
};

// The hierarchy of GET /v1/sites/:id/load-management: the service transformer is a
// root above the switchboard that names it, with a battery credit.
const HIERARCHY = [
  {
    ...panel('tfm_service', 'Utility Transformer', {
      type: 'transformer',
      transformerKind: 'service',
      breakerRatingAmps: 0,
      maxContinuousKw: 475,
      currentDrawKw: 190,
      phaseLoad: { L1: 60, L2: 65, L3: 65 },
      perPhaseCapacityKw: 158.33,
      supplyCreditKw: 50,
      childPanels: [panel('pnl_main', 'Main Switchboard')],
    }),
  },
];

function renderTree(props: Partial<Parameters<typeof PanelTree>[0]> = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PanelTree
        siteId="site1"
        hierarchy={HIERARCHY}
        stations={[]}
        transformers={[SERVICE, STEP_DOWN, UNRATED]}
        canWrite
        onRefresh={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
}

// The tree starts collapsed: open every node, top down, until none is closed.
function expandAll(): void {
  for (;;) {
    const closed = screen.queryAllByRole('button', { name: 'loadManagement.expand' });
    if (closed.length === 0) return;
    for (const button of closed) fireEvent.click(button);
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PanelTree transformers', () => {
  it('starts with every transformer and panel collapsed', () => {
    renderTree();
    expect(screen.getAllByRole('button', { name: 'loadManagement.expand' }).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole('button', { name: 'loadManagement.collapse' })).toBeNull();
    expect(screen.queryByText('Main Switchboard')).toBeNull();
    expandAll();
    expect(screen.getByText('Main Switchboard')).toBeTruthy();
  });

  it('opens a collapsed panel when a circuit is added under it', () => {
    renderTree();
    const collapse = (): number =>
      screen.queryAllByRole('button', { name: 'loadManagement.collapse', hidden: true }).length;
    // Open the transformer so its switchboard shows, still collapsed.
    const [openTransformer] = screen.getAllByRole('button', { name: 'loadManagement.expand' });
    if (openTransformer == null) throw new Error('no expand button');
    fireEvent.click(openTransformer);
    const before = collapse();
    const [addCircuit] = screen.getAllByRole('button', { name: 'loadManagement.addCircuit' });
    if (addCircuit == null) throw new Error('no Add Circuit button');
    fireEvent.click(addCircuit);
    // The modal dialog hides the tree from role queries, so count hidden buttons too.
    expect(collapse()).toBe(before + 1);
  });

  it('shows a transformer card above the panels it feeds, with its load per phase and its credit', () => {
    renderTree();
    expandAll();
    const card = screen.getByTestId('transformer-node-tfm_service');
    const view = within(card);
    expect(view.getByText('Utility Transformer')).toBeTruthy();
    expect(view.getByText('loadManagement.kindService')).toBeTruthy();
    expect(view.getByText('500 kVA')).toBeTruthy();
    expect(view.getByText('loadManagement.powerFactorValue:{"value":"0.95"}')).toBeTruthy();
    expect(view.getByText('loadManagement.loadingLimitValue:{"percent":"100"}')).toBeTruthy();
    expect(view.getByTestId('transformer-load').textContent).toBe(
      'loadManagement.transformerLoad:{"kw":"190.0","capacity":"475.0","percent":"40"}',
    );
    // Three-phase: one bar per phase, and the total with the local supply segment.
    expect(view.getByText('L1')).toBeTruthy();
    expect(view.getByText('L3')).toBeTruthy();
    expect(view.getAllByTestId('power-bar-credit').length).toBe(1);
    expect(view.getByText('loadManagement.powerBarLocalSupply:{"kw":"50.0"}')).toBeTruthy();
    // The switchboard renders inside the transformer card.
    expect(view.getByText('Main Switchboard')).toBeTruthy();
  });

  it('lists unrated and unused transformers apart, since they limit nothing', () => {
    renderTree();
    const unlinked = screen.getByTestId('unlinked-transformers');
    expect(within(unlinked).getByText('Old Transformer')).toBeTruthy();
    expect(within(unlinked).getByText('Step Down T2')).toBeTruthy();
    expect(within(unlinked).getByText('loadManagement.ratedKvaUnknown')).toBeTruthy();
    expect(within(unlinked).queryByText('Utility Transformer')).toBeNull();
  });

  it('deletes a transformer only after the confirmation', async () => {
    apiMock.delete.mockResolvedValue(undefined);
    renderTree();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'loadManagement.deleteTransformerNamed:{"name":"Old Transformer"}',
      }),
    );
    expect(apiMock.delete).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('loadManagement.confirmDeleteTransformer')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /common.delete/ }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/sites/site1/transformers/tfm_old');
    });
  });

  it('is read only without loadManagement:write', () => {
    renderTree({ canWrite: false });
    expect(
      screen.queryByRole('button', { name: /loadManagement.editTransformerNamed/ }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /loadManagement.deleteTransformerNamed/ }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'loadManagement.editPanel' })).toBeNull();
    expect(screen.queryByRole('button', { name: /loadManagement.addSubPanel/ })).toBeNull();
    // The facts still show.
    expect(screen.getByTestId('transformer-node-tfm_service')).toBeTruthy();
  });

  it('links a switchboard to a service transformer through Fed by Transformer', async () => {
    apiMock.patch.mockResolvedValue({ id: 'pnl_main' });
    renderTree();
    expandAll();
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.editPanel' }));
    const select = document.getElementById('panel-transformer') as HTMLSelectElement;
    // A top-level panel takes rated service transformers only.
    expect([...select.options].map((o) => o.value)).toEqual(['', 'tfm_service']);
    expect(select.value).toBe('tfm_service');
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.patch.mock.calls[0]?.[0]).toBe('/v1/sites/site1/panels/pnl_main');
    const body = apiMock.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.transformerId).toBeNull();
    // The panel PATCH does not move a panel, so the form sends no parent.
    expect(body).not.toHaveProperty('parentPanelId');
  });

  it('offers a sub-panel the step-down transformers fed from its parent', async () => {
    apiMock.post.mockResolvedValue({ id: 'pnl_new' });
    renderTree();
    expandAll();
    fireEvent.click(screen.getByRole('button', { name: /loadManagement.addSubPanel/ }));
    // Add Sub-Panel starts with the panel as the parent.
    const parent = document.getElementById('parent-panel') as HTMLSelectElement;
    expect(parent.value).toBe('pnl_main');
    // The transformer node is not offered as a parent.
    expect([...parent.options].map((o) => o.value)).toEqual(['', 'pnl_main']);
    const select = document.getElementById('panel-transformer') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'tfm_sd']);
    fireEvent.change(document.getElementById('panel-name') as HTMLInputElement, {
      target: { value: 'Level 2 Panel' },
    });
    fireEvent.change(select, { target: { value: 'tfm_sd' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.post.mock.calls[0]?.[1]).toMatchObject({
      parentPanelId: 'pnl_main',
      transformerId: 'tfm_sd',
    });
  });
});

describe('transformerOptionsFor', () => {
  it('follows the tree rules: rated service for a top-level panel, rated step-down fed from the parent for a sub-panel', () => {
    const all = [SERVICE, STEP_DOWN, UNRATED];
    expect(transformerOptionsFor(all, null).map((tx) => tx.id)).toEqual(['tfm_service']);
    expect(transformerOptionsFor(all, 'pnl_main').map((tx) => tx.id)).toEqual(['tfm_sd']);
    expect(transformerOptionsFor(all, 'pnl_other')).toEqual([]);
  });
});
