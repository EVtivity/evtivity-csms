// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Charging Type (AC, DC, Both) and Site Availability (All Sites, Selected
// Sites) of a tariff (owner decisions 2026-11-13). Site Availability shows
// only for a group that may limit tariffs to sites (a driver or fleet group);
// otherwise a note says why it is missing.

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TariffChargingType } from '@evtivity/lib/tariff-scope';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';

export interface TariffScopeValue {
  chargingType: TariffChargingType;
  /** Null: All Sites. */
  siteIds: string[] | null;
}

interface Site {
  id: string;
  name: string;
}

function isChargingType(value: string): value is TariffChargingType {
  return value === 'ac' || value === 'dc' || value === 'both';
}

/** The label of a tariff's charging type. */
export function useChargingTypeLabel(): (type: TariffChargingType | undefined) => string {
  const { t } = useTranslation();
  return (type) =>
    type === 'ac'
      ? t('pricing.chargingTypeAc')
      : type === 'dc'
        ? t('pricing.chargingTypeDc')
        : t('pricing.chargingTypeBoth');
}

/**
 * A tariff's sites as names: All Sites, or the selected sites the reader may
 * see, with the count of the others.
 */
export function TariffSitesSummary({
  siteIds,
  otherSiteCount = 0,
}: {
  siteIds: string[] | null | undefined;
  otherSiteCount?: number | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: Site[] }>('/v1/sites?limit=100'),
    enabled: siteIds != null && siteIds.length > 0,
  });
  if (siteIds == null) return <>{t('pricing.allSites')}</>;
  if (siteIds.length === 0 && otherSiteCount === 0) return <>{t('pricing.noSitesSelected')}</>;
  const names = siteIds.map((id) => sitesData?.data.find((s) => s.id === id)?.name ?? id);
  const others = otherSiteCount > 0 ? t('pricing.otherSites', { count: otherSiteCount }) : null;
  return <>{[...names, ...(others != null ? [others] : [])].join(', ')}</>;
}

export function TariffScopeFields({
  value,
  onChange,
  siteAvailabilityAllowed,
  idPrefix,
  error,
}: {
  value: TariffScopeValue;
  onChange: (next: TariffScopeValue) => void;
  siteAvailabilityAllowed: boolean;
  idPrefix: string;
  /** The message under the site list (for example none selected). */
  error?: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const selected = value.siteIds != null;
  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: Site[] }>('/v1/sites?limit=100'),
    enabled: siteAvailabilityAllowed && selected,
  });
  const sites = sitesData?.data ?? [];

  return (
    <div className="col-span-full grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-charging-type`} className="leading-6">
          {t('pricing.chargingType')}
        </Label>
        <Select
          id={`${idPrefix}-charging-type`}
          value={value.chargingType}
          onChange={(e) => {
            if (isChargingType(e.target.value))
              onChange({ ...value, chargingType: e.target.value });
          }}
        >
          <option value="both">{t('pricing.chargingTypeBoth')}</option>
          <option value="ac">{t('pricing.chargingTypeAc')}</option>
          <option value="dc">{t('pricing.chargingTypeDc')}</option>
        </Select>
        <p className="text-xs text-muted-foreground">{t('pricing.chargingTypeHelper')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-site-availability`} className="leading-6">
          {t('pricing.siteAvailability')}
        </Label>
        {siteAvailabilityAllowed ? (
          <>
            <Select
              id={`${idPrefix}-site-availability`}
              value={selected ? 'selected' : 'all'}
              onChange={(e) => {
                onChange({ ...value, siteIds: e.target.value === 'selected' ? [] : null });
              }}
            >
              <option value="all">{t('pricing.allSites')}</option>
              <option value="selected">{t('pricing.selectedSites')}</option>
            </Select>
            <p className="text-xs text-muted-foreground">{t('pricing.siteAvailabilityHelper')}</p>
            {selected && (
              <div
                className={`max-h-48 overflow-y-auto rounded-md border p-3 space-y-2 ${
                  error != null ? 'border-destructive' : 'border-border'
                }`}
              >
                {sites.map((site) => (
                  <div key={site.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`${idPrefix}-site-${site.id}`}
                      checked={value.siteIds?.includes(site.id) === true}
                      onChange={(e) => {
                        const current = value.siteIds ?? [];
                        onChange({
                          ...value,
                          siteIds: e.target.checked
                            ? [...current, site.id]
                            : current.filter((id) => id !== site.id),
                        });
                      }}
                    />
                    <Label htmlFor={`${idPrefix}-site-${site.id}`}>{site.name}</Label>
                  </div>
                ))}
              </div>
            )}
            {error != null && <p className="text-xs text-destructive">{error}</p>}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('pricing.siteAvailabilityNotAllowed')}</p>
        )}
      </div>
    </div>
  );
}
