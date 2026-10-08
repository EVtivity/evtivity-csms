// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock, getMock, toastMock, permission, ui } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  getMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
  ui: { language: 'en' },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: ui.language },
  }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { patch: patchMock, get: getMock }, ApiError };
});

vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { FleetCreditLimitCard } from '../fleet/FleetCreditLimitCard';
import type { FleetCreditLimit } from '../fleet/FleetCreditLimitCard';

const exposure = {
  unbilledCents: 6000,
  invoicedCents: 2000,
  runningCents: 500,
  totalCents: 8500,
  currency: 'USD',
};

function wrap(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FleetCreditLimitCard fleetId="flt_1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permission.canWrite = true;
  ui.language = 'en';
});

describe('FleetCreditLimitCard', () => {
  it('shows the limit, the level and the exposure', async () => {
    getMock.mockResolvedValue({
      creditLimitCents: 10_000,
      warningPercent: 80,
      exposure,
      level: 'warning',
    } satisfies FleetCreditLimit);
    wrap();

    expect(await screen.findByText('fleets.creditLimit.levelWarning')).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith('/v1/fleets/flt_1/credit-limit');
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('$85.00')).toBeTruthy();
    expect(screen.getByText('$60.00')).toBeTruthy();
  });

  it('shows no limit and no level for a fleet without a limit', async () => {
    getMock.mockResolvedValue({
      creditLimitCents: null,
      warningPercent: 80,
      exposure,
      level: null,
    } satisfies FleetCreditLimit);
    wrap();

    expect(await screen.findByText('fleets.creditLimit.noLimit')).toBeTruthy();
    expect(screen.queryByText('fleets.creditLimit.levelOk')).toBeNull();
  });

  it('saves a new limit in cents and the warning percent', async () => {
    getMock.mockResolvedValue({
      creditLimitCents: null,
      warningPercent: 80,
      exposure,
      level: null,
    } satisfies FleetCreditLimit);
    patchMock.mockResolvedValue({
      creditLimitCents: 25_050,
      warningPercent: 90,
      exposure,
      level: 'ok',
    } satisfies FleetCreditLimit);
    wrap();

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText(/fleets.creditLimit.limit/), {
      target: { value: '250.50' },
    });
    fireEvent.change(screen.getByLabelText('fleets.creditLimit.warningPercent'), {
      target: { value: '90' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/credit-limit', {
        creditLimitCents: 25_050,
        warningPercent: 90,
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'fleets.creditLimit.updated', variant: 'success' }),
      );
    });
  });

  it.each([
    ['de', '10,5'],
    ['de', '10.5'],
    ['en', '10.5'],
    ['en', '10,5'],
  ])('reads the amount in %s typed as %s as 1050 cents', async (language, typed) => {
    ui.language = language;
    getMock.mockResolvedValue({
      creditLimitCents: null,
      warningPercent: 80,
      exposure,
      level: null,
    } satisfies FleetCreditLimit);
    patchMock.mockResolvedValue({
      creditLimitCents: 1050,
      warningPercent: 80,
      exposure,
      level: 'ok',
    } satisfies FleetCreditLimit);
    wrap();

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText(/fleets.creditLimit.limit/), {
      target: { value: typed },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/credit-limit', {
        creditLimitCents: 1050,
        warningPercent: 80,
      });
    });
  });

  it('shows a German limit with a comma and saves it unchanged', async () => {
    ui.language = 'de';
    getMock.mockResolvedValue({
      creditLimitCents: 25_050,
      warningPercent: 80,
      exposure,
      level: 'ok',
    } satisfies FleetCreditLimit);
    patchMock.mockResolvedValue({
      creditLimitCents: 25_050,
      warningPercent: 80,
      exposure,
      level: 'ok',
    } satisfies FleetCreditLimit);
    wrap();

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    expect(screen.getByLabelText<HTMLInputElement>(/fleets.creditLimit.limit/).value).toBe(
      '250,50',
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/credit-limit', {
        creditLimitCents: 25_050,
        warningPercent: 80,
      });
    });
  });

  it('refuses a zero limit', async () => {
    getMock.mockResolvedValue({
      creditLimitCents: null,
      warningPercent: 80,
      exposure,
      level: null,
    } satisfies FleetCreditLimit);
    wrap();

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText(/fleets.creditLimit.limit/), {
      target: { value: '0,00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(await screen.findByText('fleets.creditLimit.invalidLimit')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('removes the limit when the amount is empty', async () => {
    getMock.mockResolvedValue({
      creditLimitCents: 10_000,
      warningPercent: 80,
      exposure,
      level: 'warning',
    } satisfies FleetCreditLimit);
    patchMock.mockResolvedValue({
      creditLimitCents: null,
      warningPercent: 80,
      exposure,
      level: null,
    } satisfies FleetCreditLimit);
    wrap();

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText(/fleets.creditLimit.limit/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/fleets/flt_1/credit-limit', {
        creditLimitCents: null,
        warningPercent: 80,
      });
    });
  });

  it('refuses a warning percent outside 1 to 99', async () => {
    getMock.mockResolvedValue({
      creditLimitCents: 10_000,
      warningPercent: 80,
      exposure,
      level: 'warning',
    } satisfies FleetCreditLimit);
    wrap();

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText('fleets.creditLimit.warningPercent'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(await screen.findByText('fleets.creditLimit.invalidPercent')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('hides the edit button without fleets:write', async () => {
    permission.canWrite = false;
    getMock.mockResolvedValue({
      creditLimitCents: 10_000,
      warningPercent: 80,
      exposure,
      level: 'ok',
    } satisfies FleetCreditLimit);
    wrap();

    expect(await screen.findByText('fleets.creditLimit.levelOk')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull();
  });
});
