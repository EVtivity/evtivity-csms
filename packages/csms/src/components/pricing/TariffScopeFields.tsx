// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Charging Type (AC, DC, Both) and Site Availability (All Sites, Selected
// Sites) of a tariff (owner decisions 2026-11-13). Site Availability shows
// only for a group that may limit tariffs to sites (a driver or fleet group);
// otherwise a note says why it is missing.

import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TariffChargingType } from '@evtivity/lib/tariff-scope';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/search-input';
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

/** How many sites the picker lists for a search (the sites a tariff names show apart). */
const SITE_SEARCH_LIMIT = 50;

/** How many sites one name read asks for (the API's page size). */
const SITE_NAME_BATCH = 100;

/**
 * The names of the given sites, read by their ids in batches of 100
 * (`GET /v1/sites?ids=`), so a company with more sites than one list page
 * still names every selected site, with one request per batch.
 */
function useSiteNames(siteIds: readonly string[]): Map<string, string> {
  const unique = [...new Set(siteIds)].sort();
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += SITE_NAME_BATCH) {
    batches.push(unique.slice(i, i + SITE_NAME_BATCH));
  }
  const results = useQueries({
    queries: batches.map((ids) => ({
      queryKey: ['site-names', ids],
      queryFn: () =>
        api.get<{ data: Site[] }>(
          `/v1/sites?ids=${ids.map(encodeURIComponent).join(',')}&limit=${String(SITE_NAME_BATCH)}`,
        ),
      staleTime: 60_000,
    })),
  });
  const names = new Map<string, string>();
  for (const r of results) for (const site of r.data?.data ?? []) names.set(site.id, site.name);
  return names;
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
  const siteNames = useSiteNames(siteIds ?? []);
  if (siteIds == null) return <>{t('pricing.allSites')}</>;
  if (siteIds.length === 0 && otherSiteCount === 0) return <>{t('pricing.noSitesSelected')}</>;
  const names = siteIds.map((id) => siteNames.get(id) ?? t('common.unnamedSite'));
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
  const [search, setSearch] = useState('');
  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select', search],
    queryFn: () =>
      api.get<{ data: Site[] }>(
        `/v1/sites?limit=${String(SITE_SEARCH_LIMIT)}&search=${encodeURIComponent(search)}`,
      ),
    enabled: siteAvailabilityAllowed && selected,
  });
  const pickedIds = value.siteIds ?? [];
  const pickedNames = useSiteNames(siteAvailabilityAllowed ? pickedIds : []);
  // The selected sites first (also those past the search results), then the
  // sites the search found.
  const sites: Site[] = [
    ...pickedIds.map((id) => ({ id, name: pickedNames.get(id) ?? t('common.unnamedSite') })),
    ...(sitesData?.data ?? []).filter((site) => !pickedIds.includes(site.id)),
  ];

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
              <>
                <Label htmlFor={`${idPrefix}-site-search`} className="sr-only">
                  {t('sites.search')}
                </Label>
                <SearchInput
                  id={`${idPrefix}-site-search`}
                  value={search}
                  onDebouncedChange={setSearch}
                  placeholder={t('sites.searchPlaceholder')}
                  className="max-w-none"
                />
              </>
            )}
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
