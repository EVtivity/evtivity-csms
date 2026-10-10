// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatCents } from '@/lib/formatting';

/** Link to a site's electricity rate settings (Site Detail, Electricity Rates tab). */
export function electricityRatesPath(siteId: string): string {
  return `/sites/${siteId}?tab=electricity-rates`;
}

export interface CostMissingSite {
  siteId: string;
  siteName: string;
  sessionCount: number;
  revenueCents: number;
}

/**
 * Dashboard notice: sessions without an electricity cost are left out of
 * profit. Lists the sites that have them, each linking to its electricity
 * rate settings. Hidden from users who cannot edit sites.
 */
export function CostMissingDashboardNotice({
  sessionCount,
  revenueCents,
  currency,
  sites,
}: {
  sessionCount: number;
  revenueCents: number;
  currency: string | undefined;
  sites: readonly CostMissingSite[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const canEditSites = useHasPermission('sites:write');
  if (!canEditSites || currency == null || sites.length === 0 || sessionCount === 0) return null;

  return (
    <Alert variant="warning" data-testid="cost-missing-notice">
      <AlertTriangle />
      <AlertDescription className="space-y-1">
        <p>
          {t('dashboard.costMissingNotice', {
            count: sessionCount,
            revenue: formatCents(revenueCents, currency),
          })}
        </p>
        <p>
          {t('dashboard.costMissingSites')}{' '}
          {sites.map((site, index) => (
            <Fragment key={site.siteId}>
              {index > 0 && ', '}
              <Link to={electricityRatesPath(site.siteId)} className="text-primary hover:underline">
                {site.siteName}
              </Link>{' '}
              ({site.sessionCount})
            </Fragment>
          ))}
        </p>
      </AlertDescription>
    </Alert>
  );
}

interface RatePeriod {
  id: number;
  isDefault: boolean;
}

/**
 * Site page notice: the site has no electricity rate period, or only
 * restricted ones without a default, so some or all of its sessions get no
 * electricity cost and are left out of profit. Hidden from users who cannot
 * edit sites.
 */
export function SiteElectricityRatesNotice({
  siteId,
  onOpenRates,
}: {
  siteId: string;
  onOpenRates: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const canEditSites = useHasPermission('sites:write');
  // Same query key as the Electricity Rates tab, so both share one request.
  const { data: periods } = useQuery({
    queryKey: ['site-electricity-rates', siteId],
    queryFn: () => api.get<RatePeriod[]>(`/v1/sites/${siteId}/electricity-rates`),
    enabled: canEditSites && siteId !== '',
  });
  if (!canEditSites || periods == null) return null;

  const message =
    periods.length === 0
      ? t('sites.electricityRatesMissing')
      : periods.some((p) => p.isDefault)
        ? null
        : t('sites.electricityRatesNoDefault');
  if (message == null) return null;

  return (
    <Alert variant="warning" data-testid="electricity-rates-notice">
      <AlertTriangle />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        <Button variant="outline" size="sm" onClick={onOpenRates}>
          {t('sites.electricityRatesOpen')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
