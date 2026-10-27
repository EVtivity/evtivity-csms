// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/auth', () => ({ useHasCompanyWidePermission: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PricingHolidays } from '@/pages/PricingHolidays';

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PricingHolidays />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.get.mockResolvedValue([]);
  apiMock.post.mockResolvedValue({ created: 1, skipped: 0 });
});

afterEach(() => {
  cleanup();
});

describe('PricingHolidays dialogs', () => {
  it('spaces the Add Holiday form like the standard dialog, with its buttons in the footer', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('pricing.addHoliday'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('pricing.addHolidayDescription')).toBeTruthy();
    const form = screen.getByTestId('holiday-create-form');
    expect(form.className).toContain('grid');
    expect(form.className).toContain('gap-4');
    const cancel = within(form).getByText('common.cancel');
    const create = within(form).getByText('common.create');
    expect(cancel.parentElement).toBe(create.parentElement);
    expect(cancel.parentElement?.parentElement).toBe(form);
  });

  it('spaces the Bulk Add form the same way and submits it', async () => {
    renderPage();
    const openButtons = await screen.findAllByText('pricing.bulkAdd');
    fireEvent.click(openButtons[0] as HTMLElement);
    const form = await screen.findByTestId('holiday-bulk-form');
    expect(form.className).toContain('gap-4');
    expect(screen.getByText('pricing.bulkAddDescription')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('pricing.holidays'), {
      target: { value: '2026-12-25 Christmas' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/pricing-holidays/bulk', expect.anything());
    });
  });
});
