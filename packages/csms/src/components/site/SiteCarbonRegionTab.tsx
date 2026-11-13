// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TabPanel } from '@/components/ui/tab-panel';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

interface Site {
  id: string;
  carbonRegionCode: string | null;
}

interface CarbonFactor {
  id: number;
  regionCode: string;
  regionName: string;
  countryCode: string;
  carbonIntensityKgPerKwh: string;
  source: string;
}

export interface SiteCarbonRegionTabProps {
  site: Site;
  siteId: string;
}

function gramsPerKwh(factor: CarbonFactor): number {
  return Math.round(Number(factor.carbonIntensityKgPerKwh) * 1000);
}

/** Site detail > Carbon Region: the grid region for the site's carbon intensity. */
export function SiteCarbonRegionTab({ site, siteId }: SiteCarbonRegionTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');

  const { data: carbonFactors } = useQuery({
    queryKey: ['carbon-factors'],
    queryFn: () => api.get<CarbonFactor[]>('/v1/carbon/factors'),
  });

  const carbonRegionMutation = useMutation({
    mutationFn: (regionCode: string | null) =>
      api.put(`/v1/sites/${siteId}/carbon-region`, { regionCode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
  });

  const grouped: Record<string, CarbonFactor[]> = {};
  for (const f of carbonFactors ?? []) {
    const list = grouped[f.countryCode] ?? [];
    list.push(f);
    grouped[f.countryCode] = list;
  }
  const current =
    site.carbonRegionCode != null
      ? carbonFactors?.find((f) => f.regionCode === site.carbonRegionCode)
      : undefined;

  return (
    <TabsContent value="carbon-region">
      <TabPanel
        title={t('sites.carbonRegion')}
        description={t('sites.carbonRegionDescription')}
        bodyClassName="space-y-4"
      >
        <div className="flex items-center gap-4">
          <Select
            aria-label={t('sites.carbonRegion')}
            value={site.carbonRegionCode ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              carbonRegionMutation.mutate(val === '' ? null : val);
            }}
            disabled={!canWrite || carbonRegionMutation.isPending}
            className="max-w-sm"
          >
            <option value="">{t('sites.noCarbonRegion')}</option>
            {Object.entries(grouped).map(([groupCountry, factors]) => (
              <optgroup key={groupCountry} label={groupCountry}>
                {factors.map((f) => (
                  <option key={f.regionCode} value={f.regionCode}>
                    {f.regionName} ({gramsPerKwh(f)} g CO₂/kWh)
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          {current != null && (
            <span className="text-sm text-muted-foreground">
              {t('sites.carbonIntensity')}: {gramsPerKwh(current)} g CO₂/kWh
            </span>
          )}
        </div>
        {carbonRegionMutation.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(carbonRegionMutation.error, t)}
          </p>
        )}
      </TabPanel>
    </TabsContent>
  );
}
