// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { DATA_PLANS, isDataPlan } from '@evtivity/lib/station-data-plan';
import type { DataPlan } from '@evtivity/lib/station-data-plan';
import { api } from '@/lib/api';

export interface TargetFilterValue {
  siteId?: string;
  vendorId?: string;
  model?: string;
  stationId?: string;
  /** Configuration templates only: the stations whose effective data plan is this one. */
  dataPlan?: DataPlan;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
  stations: { id: string; stationId: string }[];
}

interface Props {
  /** GET endpoint that returns FilterOptions and accepts ?siteId&vendorId&model query params. */
  endpoint: string;
  /** Stable React Query key prefix used for caching the cascading lookups. */
  queryKeyPrefix: readonly unknown[];
  value: TargetFilterValue;
  onChange: (next: TargetFilterValue) => void;
  /** Optional id prefix for input ids (avoids collisions when used twice on one page). */
  idPrefix?: string;
  /** Help text under the heading; defaults to the configuration template text. */
  helpText?: string;
  /** Show the Data Plan selector (configuration templates). */
  showDataPlan?: boolean;
}

export function TargetFilterFields({
  endpoint,
  queryKeyPrefix,
  value,
  onChange,
  idPrefix = 'target-filter',
  helpText,
  showDataPlan = false,
}: Props): React.JSX.Element {
  const { t } = useTranslation();

  const params = new URLSearchParams();
  if (value.siteId) params.set('siteId', value.siteId);
  if (value.vendorId) params.set('vendorId', value.vendorId);
  if (value.model) params.set('model', value.model);
  const queryString = params.toString();

  const { data: options } = useQuery({
    queryKey: [...queryKeyPrefix, value.siteId ?? '', value.vendorId ?? '', value.model ?? ''],
    queryFn: () => api.get<FilterOptions>(`${endpoint}${queryString ? `?${queryString}` : ''}`),
  });

  function update(patch: Partial<TargetFilterValue>): void {
    const next: TargetFilterValue = { ...value, ...patch };
    // Any change to a parent filter clears the station selection because the
    // station list cascades from site / vendor / model.
    if ('siteId' in patch || 'vendorId' in patch || 'model' in patch) {
      delete next.stationId;
    }
    // Drop empty-string keys so the resulting object is clean for the API.
    if (next.siteId === '') delete next.siteId;
    if (next.vendorId === '') delete next.vendorId;
    if (next.model === '') delete next.model;
    if (next.stationId === '') delete next.stationId;
    onChange(next);
  }

  return (
    <>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('configTemplates.targetFilter')}</h3>
        <p className="text-xs text-muted-foreground">
          {helpText ?? t('configTemplates.targetFilterHelp')}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-site`}>{t('configTemplates.site')}</Label>
          <Select
            id={`${idPrefix}-site`}
            value={value.siteId ?? ''}
            onChange={(e) => {
              update({ siteId: e.target.value });
            }}
          >
            <option value="">{t('configTemplates.allSites')}</option>
            {options?.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-vendor`}>{t('configTemplates.vendor')}</Label>
          <Select
            id={`${idPrefix}-vendor`}
            value={value.vendorId ?? ''}
            onChange={(e) => {
              update({ vendorId: e.target.value });
            }}
          >
            <option value="">{t('configTemplates.allVendors')}</option>
            {options?.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-model`}>{t('configTemplates.model')}</Label>
          <Select
            id={`${idPrefix}-model`}
            value={value.model ?? ''}
            onChange={(e) => {
              update({ model: e.target.value });
            }}
          >
            <option value="">{t('configTemplates.allModels')}</option>
            {options?.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-station`}>{t('configTemplates.station')}</Label>
          <Select
            id={`${idPrefix}-station`}
            value={value.stationId ?? ''}
            onChange={(e) => {
              update({ stationId: e.target.value });
            }}
          >
            <option value="">{t('configTemplates.allStations')}</option>
            {options?.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.stationId}
              </option>
            ))}
          </Select>
        </div>
        {showDataPlan && (
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-data-plan`}>{t('dataPlan.title')}</Label>
            <Select
              id={`${idPrefix}-data-plan`}
              value={value.dataPlan ?? ''}
              onChange={(e) => {
                const plan = e.target.value;
                const next: TargetFilterValue = { ...value };
                if (isDataPlan(plan)) next.dataPlan = plan;
                else delete next.dataPlan;
                onChange(next);
              }}
            >
              <option value="">{t('dataPlan.any')}</option>
              {DATA_PLANS.map((plan) => (
                <option key={plan} value={plan}>
                  {t(`dataPlan.plans.${plan}`)}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
    </>
  );
}

/** Resolution helpers for showing the filter values back as labels. */
export interface TargetFilterResolvers {
  siteName: (id: string) => string;
  vendorName: (id: string) => string;
  stationName: (id: string) => string;
}
