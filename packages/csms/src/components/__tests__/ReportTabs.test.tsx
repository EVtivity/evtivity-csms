// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, delete: vi.fn() },
}));

vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { GenerateTab } from '../reports/GenerateTab';
import { SchedulesTab } from '../reports/SchedulesTab';
import { GeneratedReportsTab } from '../reports/GeneratedReportsTab';

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
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
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
  patchMock.mockReset();
});

function dateInputs(): HTMLElement[] {
  return screen
    .queryAllByLabelText('common.startDate')
    .concat(screen.queryAllByLabelText('common.endDate'));
}

function submitForm(el: HTMLElement): void {
  const form = el.closest('form');
  if (form == null) throw new Error('form not found');
  fireEvent.submit(form);
}

const SCHEDULE = {
  id: 7,
  name: 'Monthly',
  reportType: 'revenue',
  format: 'csv',
  frequency: 'monthly',
  dayOfWeek: null,
  dayOfMonth: 1,
  recipientEmails: ['ops@example.com'],
  filters: { siteId: 'sit_1', dateFrom: '2026-01-01', dateTo: '2026-01-31' },
  reportPeriod: 'custom',
  isEnabled: true,
  createdAt: '2026-01-01T00:00:00Z',
};

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

describe('Report period', () => {
  it('Generate tab hides the dates for a relative period and sends the period with the filters', async () => {
    postMock.mockResolvedValue({ id: 'r1', status: 'pending' });
    renderTab(<GenerateTab onGenerated={vi.fn()} />);
    await selectWithOptions('report-type', 2);
    const period = document.getElementById('generate-period') as HTMLSelectElement;
    expect(period.options).toHaveLength(11);
    expect(period.value).toBe('custom');
    expect(dateInputs().length).toBeGreaterThan(0);
    fireEvent.change(period, { target: { value: 'last7Days' } });
    expect(dateInputs()).toHaveLength(0);
    fireEvent.change(document.getElementById('report-name') as HTMLInputElement, {
      target: { value: 'Week' },
    });
    submitForm(period);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/reports/generate',
        expect.objectContaining({ reportPeriod: 'last7Days', filters: {} }),
      );
    });
  });

  it('Schedules tab defaults to Custom and sends no dates for Previous Month', async () => {
    postMock.mockResolvedValue({ id: 1 });
    renderTab(<SchedulesTab />);
    fireEvent.click(screen.getByText('reports.createSchedule'));
    await selectWithOptions('schedule-type', 2);
    const period = document.getElementById('schedule-period') as HTMLSelectElement;
    expect(period.options).toHaveLength(11);
    expect(period.value).toBe('custom');
    expect(dateInputs().length).toBeGreaterThan(0);
    fireEvent.change(period, { target: { value: 'previousMonth' } });
    expect(dateInputs()).toHaveLength(0);
    fireEvent.change(document.getElementById('schedule-name') as HTMLInputElement, {
      target: { value: 'Monthly' },
    });
    fireEvent.change(document.getElementById('schedule-emails') as HTMLInputElement, {
      target: { value: 'ops@example.com' },
    });
    submitForm(period);
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/report-schedules',
        expect.objectContaining({ reportPeriod: 'previousMonth', filters: {} }),
      );
    });
  });

  it('shows the period on the card and switches an edited custom schedule to Last 7 Days', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/v1/reports/types') return Promise.resolve(REPORT_TYPES);
      if (url === '/v1/report-schedules') return Promise.resolve({ data: [SCHEDULE] });
      return Promise.resolve({ data: [], total: 0 });
    });
    patchMock.mockResolvedValue({});
    try {
      renderTab(<SchedulesTab />);
      await screen.findByText('Monthly');
      expect(screen.getByText('reports.periods.custom')).toBeTruthy();
      fireEvent.click(screen.getByText('reports.editSchedule'));
      const period = document.getElementById('schedule-period') as HTMLSelectElement;
      expect(period.value).toBe('custom');
      expect(dateInputs().length).toBeGreaterThan(0);
      fireEvent.change(period, { target: { value: 'last7Days' } });
      submitForm(period);
      await waitFor(() => {
        expect(patchMock).toHaveBeenCalledWith(
          '/v1/report-schedules/7',
          expect.objectContaining({ reportPeriod: 'last7Days', filters: { siteId: 'sit_1' } }),
        );
      });
    } finally {
      getMock.mockImplementation((url: string) => {
        if (url === '/v1/reports/types') return Promise.resolve(REPORT_TYPES);
        return Promise.resolve({ data: [], total: 0 });
      });
    }
  });
});

describe('GeneratedReportsTab', () => {
  it('filters by every report type, including the ones the Generate tab does not offer', async () => {
    renderTab(<GeneratedReportsTab />);
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

  it('sorts the list on the server when a sortable header is clicked', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/v1/reports/types') return Promise.resolve(REPORT_TYPES);
      return Promise.resolve({
        data: [
          {
            id: 'rep_1',
            name: 'Q1',
            reportType: 'revenue',
            status: 'completed',
            format: 'csv',
            fileName: null,
            fileSize: 10,
            error: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            completedAt: null,
          },
        ],
        total: 1,
      });
    });
    renderTab(<GeneratedReportsTab />);
    fireEvent.click(await screen.findByTestId('sort-fileSize'));
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(expect.stringContaining('sort=fileSize&order=asc'));
    });
  });
});
