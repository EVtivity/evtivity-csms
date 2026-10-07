// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { GenerateTab } from '../reports/GenerateTab';
import { SchedulesTab } from '../reports/SchedulesTab';
import { HistoryTab } from '../reports/HistoryTab';

const ALL = ['csv', 'pdf', 'xlsx'];
const REPORT_TYPES = [
  { type: 'revenue', formats: ALL, generateFromUi: true },
  { type: 'custom', formats: ['pdf'], generateFromUi: true },
  { type: 'nevi', formats: ['xlsx'], generateFromUi: false },
];

getMock.mockImplementation((url: string) => {
  if (url === '/v1/reports/types') return Promise.resolve(REPORT_TYPES);
  return Promise.resolve({ data: [], total: 0 });
});

function renderTab(ui: React.JSX.Element): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function options(select: HTMLElement): Array<{ value: string; label: string | null }> {
  return [...(select as HTMLSelectElement).options].map((o) => ({
    value: o.value,
    label: o.textContent,
  }));
}

async function selectWithOptions(id: string, count: number): Promise<HTMLSelectElement> {
  await waitFor(() => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    expect(el?.options.length).toBe(count);
  });
  return document.getElementById(id) as HTMLSelectElement;
}

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('GenerateTab', () => {
  it('offers the types the server marks generateFromUi, labelled by locale key', async () => {
    renderTab(<GenerateTab onGenerated={vi.fn()} />);
    const typeSelect = await selectWithOptions('report-type', 2);
    expect(options(typeSelect)).toEqual([
      { value: 'revenue', label: 'reports.types.revenue' },
      { value: 'custom', label: 'reports.types.custom' },
    ]);
    expect(getMock).toHaveBeenCalledWith('/v1/reports/types');
  });

  it('offers the formats of the selected type and submits them', async () => {
    postMock.mockResolvedValue({ id: 'r1', status: 'pending' });
    renderTab(<GenerateTab onGenerated={vi.fn()} />);
    const typeSelect = await selectWithOptions('report-type', 2);
    const formatSelect = document.getElementById('report-format') as HTMLSelectElement;
    expect(options(formatSelect).map((o) => o.value)).toEqual(ALL);

    fireEvent.change(typeSelect, { target: { value: 'custom' } });
    expect(options(formatSelect)).toEqual([{ value: 'pdf', label: 'reports.formats.pdf' }]);

    fireEvent.change(document.getElementById('report-name') as HTMLInputElement, {
      target: { value: 'Custom' },
    });
    const form = typeSelect.closest('form');
    if (form == null) throw new Error('form not found');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/reports/generate',
        expect.objectContaining({ reportType: 'custom', format: 'pdf' }),
      );
    });
  });
});

describe('SchedulesTab', () => {
  it('offers the generateFromUi types and their formats in the schedule form', async () => {
    renderTab(<SchedulesTab />);
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/reports/types');
    });
    fireEvent.click(screen.getByText('reports.createSchedule'));
    const typeSelect = await selectWithOptions('schedule-type', 2);
    expect(options(typeSelect)).toEqual([
      { value: 'revenue', label: 'reports.types.revenue' },
      { value: 'custom', label: 'reports.types.custom' },
    ]);
    fireEvent.change(typeSelect, { target: { value: 'custom' } });
    const formatSelect = document.getElementById('schedule-format') as HTMLSelectElement;
    expect(options(formatSelect).map((o) => o.value)).toEqual(['pdf']);
  });
});

describe('HistoryTab', () => {
  it('filters by every report type, including the ones the Generate tab does not offer', async () => {
    renderTab(<HistoryTab />);
    await waitFor(() => {
      expect(
        screen.getAllByLabelText('common.filterByReportType')[0]?.querySelectorAll('option'),
      ).toHaveLength(4);
    });
    const filter = screen.getAllByLabelText('common.filterByReportType')[0] as HTMLElement;
    expect(options(filter)).toEqual([
      { value: '', label: 'common.all' },
      { value: 'revenue', label: 'reports.types.revenue' },
      { value: 'custom', label: 'reports.types.custom' },
      { value: 'nevi', label: 'reports.types.nevi' },
    ]);
  });
});
