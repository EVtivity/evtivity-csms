// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/components/back-button', () => ({ BackButton: () => null }));
vi.mock('@/components/entity-nav-buttons', () => ({ EntityNavButtons: () => null }));

import { ConformanceDetail } from '../ConformanceDetail';

// jsdom has no ResizeObserver; the Tabs list observes its width for scroll buttons.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const REASON =
  'PICS ContractCertificateInstallationEV not supported: The CSMS does not provide ISO 15118 contract certificate provisioning itself';

const RUN = {
  id: 7,
  status: 'completed',
  ocppVersion: 'ocpp2.1',
  sutType: 'csms',
  totalTests: 3,
  passed: 1,
  failed: 1,
  skipped: 0,
  errors: 0,
  notApplicable: 1,
  durationMs: 1500,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-10-02T00:00:00.000Z',
};

const result = (id: number, testId: string, status: string, na: boolean) => ({
  id,
  testId,
  testName: `Test ${testId}`,
  module: 'M-certificate-management',
  ocppVersion: 'ocpp2.1',
  status,
  durationMs: 0,
  steps: [],
  error: null,
  notApplicableItem: na ? 'ContractCertificateInstallationEV' : null,
  notApplicableReason: na ? REASON : null,
});

const SUMMARY = [
  {
    module: 'M-certificate-management',
    ocppVersion: 'ocpp2.1',
    total: 3,
    passed: 1,
    failed: 1,
    skipped: 0,
    errors: 0,
    notApplicable: 1,
  },
];

function renderPage(tab?: string): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/summary')
        ? SUMMARY
        : {
            run: RUN,
            results: [
              result(1, 'TC_M_24_CSMS', 'passed', false),
              result(2, 'TC_M_26_CSMS', 'notApplicable', true),
              result(3, 'TC_M_14_CSMS', 'failed', false),
            ],
          },
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/conformance/7${tab != null ? `?tab=${tab}` : ''}`]}>
        <Routes>
          <Route path="/conformance/:runId" element={<ConformanceDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConformanceDetail', () => {
  it('shows the notApplicable count and a pass rate over the applicable tests', async () => {
    renderPage();
    expect(await screen.findByText('conformance.runDetail', { exact: false })).toBeTruthy();
    // 1 passed of 2 applicable tests (3 total, 1 not applicable).
    expect(screen.getByText('50.0%')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getAllByText('conformance.notApplicable').length).toBeGreaterThan(0);
  });

  it('labels a notApplicable result and shows its PICS item and reason', async () => {
    renderPage('results');
    const row = await screen.findByTestId('conformance-result-row-TC_M_26_CSMS');
    expect(within(row).getByText('conformance.notApplicable')).toBeTruthy();

    fireEvent.click(within(row).getByTestId('row-click-target'));
    const reason = await screen.findByTestId('conformance-not-applicable-reason');
    expect(within(reason).getByText(REASON)).toBeTruthy();
    expect(
      within(reason).getByText('conformance.picsItem: ContractCertificateInstallationEV'),
    ).toBeTruthy();
    expect(screen.queryByText('conformance.noSteps')).toBeNull();
  });

  it('filters results by the notApplicable status', async () => {
    renderPage('results');
    await screen.findByTestId('conformance-result-row-TC_M_26_CSMS');
    const [statusSelect] = screen.getAllByLabelText('common.filterByStatus');
    if (statusSelect == null) throw new Error('status filter not rendered');
    fireEvent.change(statusSelect, { target: { value: 'notApplicable' } });
    await vi.waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/octt/runs/7?status=notApplicable');
    });
  });
});
