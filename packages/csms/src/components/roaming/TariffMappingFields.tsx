// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api, getApiErrorFieldDetails } from '@/lib/api';

export type TariffMappingSource = 'tariff' | 'pricingGroup';

/** The fields of a tariff mapping form. Empty strings mean "not chosen". */
export interface TariffMappingValues {
  ocpiTariffId: string;
  /** '' publishes to every partner. */
  partnerId: string;
  source: TariffMappingSource;
  tariffId: string;
  pricingGroupId: string;
}

export interface TariffMappingRecord {
  ocpiTariffId: string;
  partnerId: string | null;
  tariffId: string | null;
  pricingGroupId: string | null;
}

export interface TariffMappingBody {
  ocpiTariffId: string;
  partnerId: string | null;
  tariffId: string | null;
  pricingGroupId: string | null;
}

export const EMPTY_TARIFF_MAPPING: TariffMappingValues = {
  ocpiTariffId: '',
  partnerId: '',
  source: 'pricingGroup',
  tariffId: '',
  pricingGroupId: '',
};

export function tariffMappingValues(mapping: TariffMappingRecord): TariffMappingValues {
  return {
    ocpiTariffId: mapping.ocpiTariffId,
    partnerId: mapping.partnerId ?? '',
    source: mapping.tariffId != null ? 'tariff' : 'pricingGroup',
    tariffId: mapping.tariffId ?? '',
    pricingGroupId: mapping.pricingGroupId ?? '',
  };
}

/** The request body: exactly one of tariffId and pricingGroupId. */
export function tariffMappingBody(values: TariffMappingValues): TariffMappingBody {
  return {
    ocpiTariffId: values.ocpiTariffId.trim(),
    partnerId: values.partnerId === '' ? null : values.partnerId,
    tariffId: values.source === 'tariff' ? values.tariffId : null,
    pricingGroupId: values.source === 'pricingGroup' ? values.pricingGroupId : null,
  };
}

/** Client checks plus the field errors the API returned for the last save. */
export function tariffMappingErrors(
  values: TariffMappingValues,
  serverError: unknown,
  t: TFunction,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (values.ocpiTariffId.trim() === '') errors.ocpiTariffId = t('validation.required');
  if (values.source === 'tariff' && values.tariffId === '') {
    errors.source = t('validation.required');
  }
  if (values.source === 'pricingGroup' && values.pricingGroupId === '') {
    errors.source = t('validation.required');
  }
  const details = getApiErrorFieldDetails(serverError);
  if (details.ocpiTariffId != null && errors.ocpiTariffId == null) {
    errors.ocpiTariffId = t('roaming.tariffs.ocpiTariffIdInUse');
  }
  if (details.source != null && errors.source == null) {
    errors.source = t('roaming.tariffs.sourceRequired');
  }
  return errors;
}

interface NamedItem {
  id: string;
  name: string;
}

interface TariffMappingFieldsProps {
  idPrefix: string;
  values: TariffMappingValues;
  onChange: (values: TariffMappingValues) => void;
  /** Errors to show (empty until the form was submitted once). */
  errors: Record<string, string>;
}

/**
 * The fields of a tariff mapping: the OCPI tariff id, the partner, and the
 * internal tariff or pricing group the OCPI tariff is generated from.
 */
export function TariffMappingFields({
  idPrefix,
  values,
  onChange,
  errors,
}: TariffMappingFieldsProps): React.JSX.Element {
  const { t } = useTranslation();

  const { data: tariffList } = useQuery({
    queryKey: ['tariffs-list'],
    queryFn: () => api.get<{ data: NamedItem[]; total: number }>('/v1/pricing/tariffs'),
    staleTime: 60_000,
  });
  const { data: groupList } = useQuery({
    queryKey: ['pricing-groups'],
    queryFn: () => api.get<NamedItem[]>('/v1/pricing-groups'),
    staleTime: 60_000,
  });
  const { data: partnerList } = useQuery({
    queryKey: ['ocpi-partner-options'],
    queryFn: () =>
      api.get<{ data: NamedItem[]; total: number }>('/v1/ocpi/partners?page=1&limit=100'),
    staleTime: 60_000,
  });

  function set(patch: Partial<TariffMappingValues>): void {
    onChange({ ...values, ...patch });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-ocpi-id`} className="leading-6">
          {t('roaming.tariffs.ocpiTariffId')}
        </Label>
        <Input
          id={`${idPrefix}-ocpi-id`}
          value={values.ocpiTariffId}
          maxLength={36}
          onChange={(e) => {
            set({ ocpiTariffId: e.target.value });
          }}
          placeholder="TARIFF-001"
          className={errors.ocpiTariffId ? 'border-destructive' : ''}
        />
        {errors.ocpiTariffId && <p className="text-xs text-destructive">{errors.ocpiTariffId}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-partner`} className="leading-6">
          {t('roaming.tariffs.partner')}
        </Label>
        <Select
          id={`${idPrefix}-partner`}
          value={values.partnerId}
          onChange={(e) => {
            set({ partnerId: e.target.value });
          }}
        >
          <option value="">{t('roaming.tariffs.allPartners')}</option>
          {(partnerList?.data ?? []).map((partner) => (
            <option key={partner.id} value={partner.id}>
              {partner.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t('roaming.tariffs.partnerHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-source`} className="leading-6">
          {t('roaming.tariffs.publishedFrom')}
        </Label>
        <Select
          id={`${idPrefix}-source`}
          value={values.source}
          onChange={(e) => {
            set({ source: e.target.value as TariffMappingSource });
          }}
        >
          <option value="pricingGroup">{t('roaming.tariffs.sourcePricingGroup')}</option>
          <option value="tariff">{t('roaming.tariffs.sourceTariff')}</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {values.source === 'pricingGroup'
            ? t('roaming.tariffs.sourcePricingGroupHint')
            : t('roaming.tariffs.sourceTariffHint')}
        </p>
      </div>

      {values.source === 'pricingGroup' ? (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-group`} className="leading-6">
            {t('roaming.tariffs.pricingGroup')}
          </Label>
          <Select
            id={`${idPrefix}-group`}
            value={values.pricingGroupId}
            onChange={(e) => {
              set({ pricingGroupId: e.target.value });
            }}
            className={errors.source ? 'border-destructive' : ''}
          >
            <option value="">{t('roaming.tariffs.selectPricingGroup')}</option>
            {(groupList ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
          {errors.source && <p className="text-xs text-destructive">{errors.source}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-tariff`} className="leading-6">
            {t('roaming.tariffs.internalTariff')}
          </Label>
          <Select
            id={`${idPrefix}-tariff`}
            value={values.tariffId}
            onChange={(e) => {
              set({ tariffId: e.target.value });
            }}
            className={errors.source ? 'border-destructive' : ''}
          >
            <option value="">{t('roaming.tariffs.selectTariff')}</option>
            {(tariffList?.data ?? []).map((tariff) => (
              <option key={tariff.id} value={tariff.id}>
                {tariff.name}
              </option>
            ))}
          </Select>
          {errors.source && <p className="text-xs text-destructive">{errors.source}</p>}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('roaming.tariffs.generatedHint')}</p>
    </div>
  );
}
