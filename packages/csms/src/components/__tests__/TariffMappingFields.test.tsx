// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFunction } from 'i18next';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: vi.fn((url: string) => {
        if (url.startsWith('/v1/pricing-groups')) {
          return Promise.resolve([{ id: 'pgr_000000000001', name: 'Default group' }]);
        }
        if (url.startsWith('/v1/pricing/tariffs')) {
          return Promise.resolve({
            data: [{ id: 'trf_000000000001', name: 'Standard' }],
            total: 1,
          });
        }
        return Promise.resolve({ data: [{ id: 'opr_000000000001', name: 'Partner A' }], total: 1 });
      }),
    },
  };
});

import { ApiError } from '@/lib/api';
import {
  EMPTY_TARIFF_MAPPING,
  TariffMappingFields,
  tariffMappingBody,
  tariffMappingErrors,
  tariffMappingValues,
} from '../roaming/TariffMappingFields';
import type { TariffMappingValues } from '../roaming/TariffMappingFields';

const t = ((key: string) => key) as unknown as TFunction;

afterEach(() => {
  cleanup();
});

describe('tariff mapping form helpers', () => {
  it('sends exactly one source and null for every partner', () => {
    expect(
      tariffMappingBody({
        ocpiTariffId: ' T-1 ',
        partnerId: '',
        source: 'pricingGroup',
        tariffId: 'trf_000000000001',
        pricingGroupId: 'pgr_000000000001',
      }),
    ).toEqual({
      ocpiTariffId: 'T-1',
      partnerId: null,
      tariffId: null,
      pricingGroupId: 'pgr_000000000001',
    });
  });

  it('reads a stored mapping back into the form', () => {
    expect(
      tariffMappingValues({
        ocpiTariffId: 'T-1',
        partnerId: 'opr_000000000001',
        tariffId: 'trf_000000000001',
        pricingGroupId: null,
      }),
    ).toEqual({
      ocpiTariffId: 'T-1',
      partnerId: 'opr_000000000001',
      source: 'tariff',
      tariffId: 'trf_000000000001',
      pricingGroupId: '',
    });
  });

  it('requires the OCPI tariff id and the selected source', () => {
    expect(tariffMappingErrors(EMPTY_TARIFF_MAPPING, null, t)).toEqual({
      ocpiTariffId: 'validation.required',
      source: 'validation.required',
    });
  });

  it('shows the API conflict on the OCPI tariff id field', () => {
    const values: TariffMappingValues = {
      ...EMPTY_TARIFF_MAPPING,
      ocpiTariffId: 'T-1',
      pricingGroupId: 'pgr_000000000001',
    };
    const error = new ApiError(400, {
      code: 'VALIDATION_ERROR',
      details: { ocpiTariffId: 'taken' },
    });
    expect(tariffMappingErrors(values, error, t)).toEqual({
      ocpiTariffId: 'roaming.tariffs.ocpiTariffIdInUse',
    });
  });
});

describe('TariffMappingFields', () => {
  function renderFields(values: TariffMappingValues, onChange = vi.fn()) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TariffMappingFields idPrefix="t" values={values} onChange={onChange} errors={{}} />
      </QueryClientProvider>,
    );
    return onChange;
  }

  it('lists pricing groups for a pricing group source and partners with "all partners"', async () => {
    renderFields(EMPTY_TARIFF_MAPPING);
    expect(await screen.findByText('Default group')).toBeDefined();
    expect(await screen.findByText('Partner A')).toBeDefined();
    expect(screen.getByText('roaming.tariffs.allPartners')).toBeDefined();
    expect(screen.getByText('roaming.tariffs.sourcePricingGroupHint')).toBeDefined();
  });

  it('switches the source to a tariff', () => {
    const onChange = renderFields(EMPTY_TARIFF_MAPPING);
    fireEvent.change(screen.getByLabelText('roaming.tariffs.publishedFrom'), {
      target: { value: 'tariff' },
    });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_TARIFF_MAPPING, source: 'tariff' });
  });

  it('lists tariffs for a tariff source', async () => {
    renderFields({ ...EMPTY_TARIFF_MAPPING, source: 'tariff' });
    expect(await screen.findByText('Standard')).toBeDefined();
    expect(screen.getByText('roaming.tariffs.sourceTariffHint')).toBeDefined();
  });
});
