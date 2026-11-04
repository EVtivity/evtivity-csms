// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The fields of a bus depot system, shared by the create dialog and the edit
// form: name, type, depots (Depot sites only) and the connection timings.

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { siteTypeOf, type SiteType } from '@evtivity/lib/site-layout';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { LoadingState } from '@/components/ui/content-state';
import { api } from '@/lib/api';
import {
  DEPOT_TIMING_FIELDS,
  VDV463_PRESYSTEM_TYPES,
  isValidPresystemId,
  type DepotSystem,
  type DepotSystemType,
  type DepotTimingKey,
} from './depot-system-types';

/** The form values as typed. */
export interface DepotSystemFormValues {
  presystemId: string;
  name: string;
  systemType: DepotSystemType;
  siteIds: string[];
  timings: Record<DepotTimingKey, string>;
}

export function emptyDepotSystemForm(): DepotSystemFormValues {
  return {
    presystemId: '',
    name: '',
    systemType: 'BMS',
    siteIds: [],
    timings: Object.fromEntries(
      DEPOT_TIMING_FIELDS.map((f) => [f.key, String(f.range.default)]),
    ) as Record<DepotTimingKey, string>,
  };
}

export function depotSystemFormOf(system: DepotSystem): DepotSystemFormValues {
  return {
    presystemId: system.presystemId,
    name: system.name,
    systemType: system.systemType,
    siteIds: [...system.siteIds].sort(),
    timings: Object.fromEntries(
      DEPOT_TIMING_FIELDS.map((f) => [f.key, String(system[f.key])]),
    ) as Record<DepotTimingKey, string>,
  };
}

/** The validation errors, keyed by field (`presystemId` only when creating). */
export function depotSystemFormErrors(
  values: DepotSystemFormValues,
  t: TFunction,
  creating: boolean,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (creating) {
    const id = values.presystemId.trim();
    if (id === '') errors['presystemId'] = t('validation.required');
    else if (!isValidPresystemId(id)) errors['presystemId'] = t('depotSystems.presystemIdInvalid');
  }
  const name = values.name.trim();
  if (name === '') errors['name'] = t('validation.required');
  else if (name.length > 100) errors['name'] = t('depotSystems.nameTooLong');
  if (values.siteIds.length === 0) errors['siteIds'] = t('depotSystems.depotsRequired');
  for (const f of DEPOT_TIMING_FIELDS) {
    const n = Number(values.timings[f.key]);
    if (
      values.timings[f.key].trim() === '' ||
      !Number.isInteger(n) ||
      n < f.range.min ||
      n > f.range.max
    ) {
      errors[f.key] = t('depotSystems.timingRange', { min: f.range.min, max: f.range.max });
    }
  }
  return errors;
}

/** The timings of a request body. */
export function depotTimingsBody(values: DepotSystemFormValues): Record<DepotTimingKey, number> {
  return Object.fromEntries(
    DEPOT_TIMING_FIELDS.map((f) => [f.key, Number(values.timings[f.key])]),
  ) as Record<DepotTimingKey, number>;
}

interface SiteOption {
  id: string;
  name: string;
  layoutSettings?: { siteType?: SiteType } | null;
}

export const DEPOT_SITE_OPTIONS_KEY = ['sites', 'depot-system-options'] as const;

/** The Depot sites a bus depot system may serve (from `GET /v1/sites`). */
export function useDepotSiteOptions(): {
  sites: { id: string; name: string }[];
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: DEPOT_SITE_OPTIONS_KEY,
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
  });
  const sites = (data?.data ?? [])
    .filter((s) => siteTypeOf(s.layoutSettings ?? {}) === 'depot')
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { sites, isLoading };
}

export function DepotSystemFields({
  idPrefix,
  values,
  onChange,
  errors,
  creating,
  disabled = false,
}: {
  idPrefix: string;
  values: DepotSystemFormValues;
  onChange: (next: DepotSystemFormValues) => void;
  errors: Record<string, string>;
  creating: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { sites, isLoading } = useDepotSiteOptions();
  // A stored depot that is no Depot site any more still shows, so it can be removed.
  const shownSites = [
    ...sites,
    ...values.siteIds
      .filter((id) => !sites.some((s) => s.id === id))
      .map((id) => ({ id, name: id })),
  ];
  const error = (key: string): React.JSX.Element | null =>
    errors[key] != null ? <p className="text-sm text-destructive">{errors[key]}</p> : null;

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-name`}>{t('depotSystems.name')}</Label>
          <Input
            id={`${idPrefix}-name`}
            value={values.name}
            disabled={disabled}
            maxLength={100}
            onChange={(e) => {
              onChange({ ...values, name: e.target.value });
            }}
            className={errors['name'] != null ? 'border-destructive' : ''}
          />
          {error('name')}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-type`}>{t('depotSystems.type')}</Label>
          <Select
            id={`${idPrefix}-type`}
            value={values.systemType}
            disabled={disabled}
            onChange={(e) => {
              onChange({ ...values, systemType: e.target.value as DepotSystemType });
            }}
          >
            {VDV463_PRESYSTEM_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`depotSystems.types.${type}`)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">{t('depotSystems.typeHelp')}</p>
        </div>
      </div>
      {creating && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-presystem-id`}>{t('depotSystems.systemId')}</Label>
          <Input
            id={`${idPrefix}-presystem-id`}
            value={values.presystemId}
            autoComplete="off"
            maxLength={255}
            onChange={(e) => {
              onChange({ ...values, presystemId: e.target.value });
            }}
            className={errors['presystemId'] != null ? 'border-destructive' : ''}
          />
          <p className="text-xs text-muted-foreground">{t('depotSystems.systemIdHelp')}</p>
          {error('presystemId')}
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium leading-6">{t('depotSystems.depots')}</legend>
        {isLoading ? (
          <LoadingState />
        ) : shownSites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('depotSystems.noDepotSites')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {shownSites.map((site) => (
              <div key={site.id} className="flex items-center gap-2">
                <Checkbox
                  id={`${idPrefix}-site-${site.id}`}
                  checked={values.siteIds.includes(site.id)}
                  disabled={disabled}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...values.siteIds, site.id]
                      : values.siteIds.filter((id) => id !== site.id);
                    onChange({ ...values, siteIds: [...new Set(next)].sort() });
                  }}
                />
                <Label
                  htmlFor={`${idPrefix}-site-${site.id}`}
                  className="font-normal wrap-anywhere"
                >
                  {site.name}
                </Label>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('depotSystems.depotsHelp')}</p>
        {error('siteIds')}
      </fieldset>
      <Collapsible title={t('depotSystems.connectionTimings')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {DEPOT_TIMING_FIELDS.map((f) => (
            <div key={f.key} className="grid gap-2">
              <Label htmlFor={`${idPrefix}-${f.key}`}>{t(`depotSystems.timings.${f.key}`)}</Label>
              <Input
                id={`${idPrefix}-${f.key}`}
                type="number"
                inputMode="numeric"
                min={f.range.min}
                max={f.range.max}
                step={1}
                value={values.timings[f.key]}
                disabled={disabled}
                onChange={(e) => {
                  onChange({ ...values, timings: { ...values.timings, [f.key]: e.target.value } });
                }}
                className={errors[f.key] != null ? 'border-destructive' : ''}
              />
              <p className="text-xs text-muted-foreground">
                {t(`depotSystems.timingsHelp.${f.key}`, {
                  min: f.range.min,
                  max: f.range.max,
                  default: f.range.default,
                })}
              </p>
              {error(f.key)}
            </div>
          ))}
        </div>
      </Collapsible>
    </div>
  );
}
