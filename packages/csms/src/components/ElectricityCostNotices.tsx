// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardList,
  CardListItem,
  CardListLink,
  CardTitle,
} from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { RecalculateButton } from '@/components/recalculate-button';
import { api, ApiError } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatCents } from '@/lib/formatting';

/** Link to a site's electricity rate settings (Site Detail, Electricity Rates tab). */
export function electricityRatesPath(siteId: string): string {
  return `/sites/${siteId}?tab=electricity-rates`;
}

/** Link to the sessions list filtered to a site's sessions without an electricity cost. */
export function costMissingSessionsPath(siteId: string): string {
  return `/sessions?siteId=${encodeURIComponent(siteId)}&costMissing=true`;
}

export interface CostMissingSite {
  siteId: string;
  siteName: string;
  /** False: the site has no rate period. True: its sessions can be recalculated. */
  hasRatePeriods: boolean;
  sessionCount: number;
  revenueCents: number;
}

interface RecalculateResult {
  updated: number;
  remaining: number;
}

/** Requests at most per click: each fills up to 5000 costs (the route's limit). */
const MAX_RECALCULATE_ROUNDS = 20;

/**
 * Recalculate electricity cost of one site (POST
 * /v1/sites/:id/electricity-cost/recalculate) behind a ConfirmDialog. Repeats
 * the request while it fills costs and some remain. Hidden from users who
 * cannot edit sites.
 */
export function RecalculateElectricityCostAction({
  siteId,
  siteName,
  size = 'sm',
}: {
  siteId: string;
  siteName: string;
  size?: 'default' | 'sm';
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEditSites = useHasPermission('sites:write');
  const [open, setOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: async (): Promise<RecalculateResult & { more: boolean }> => {
      const total = { updated: 0, remaining: 0, more: false };
      for (let round = 0; round < MAX_RECALCULATE_ROUNDS; round++) {
        const result = await api.post<RecalculateResult>(
          `/v1/sites/${siteId}/electricity-cost/recalculate`,
          {},
        );
        total.updated += result.updated;
        total.remaining = result.remaining;
        // Stopped by the round limit while costs were still being filled.
        total.more = result.updated > 0 && result.remaining > 0;
        if (!total.more) break;
      }
      return total;
    },
    onSuccess: (result) => {
      setOpen(false);
      const remaining =
        result.remaining > 0
          ? t(
              result.more
                ? 'sites.electricityCostRecalculateMore'
                : 'sites.electricityCostRecalculateRemaining',
              { count: result.remaining },
            )
          : undefined;
      toast({
        title:
          result.updated > 0
            ? t('sites.electricityCostRecalculated', { count: result.updated })
            : t('sites.electricityCostRecalculateNone'),
        ...(remaining != null ? { description: remaining } : {}),
        variant: result.updated > 0 ? 'success' : 'default',
      });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
    },
    onError: (err: unknown) => {
      toast({
        title: err instanceof ApiError ? err.message : t('common.error'),
        variant: 'destructive',
      });
    },
  });

  if (!canEditSites) return null;

  return (
    <>
      <RecalculateButton
        label={t('sites.electricityCostRecalculate')}
        size={size}
        disabled={mutation.isPending}
        onClick={() => {
          setOpen(true);
        }}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('sites.electricityCostRecalculateTitle')}
        description={t('sites.electricityCostRecalculateConfirm', { site: siteName })}
        confirmLabel={t('sites.electricityCostRecalculate')}
        variant="default"
        isPending={mutation.isPending}
        onConfirm={() => {
          mutation.mutate();
          return false;
        }}
      />
    </>
  );
}

/** Site rows the dashboard card shows at most; a footer links to the rest. */
export const MAX_COST_MISSING_SITE_ROWS = 5;

/** Every site's sessions without an electricity cost, in the user's site scope. */
const COST_MISSING_SESSIONS_PATH = '/sessions?costMissing=true';

/** Sites without rate periods first (they need setup), then the most sessions without a cost. */
export function orderCostMissingSites(sites: readonly CostMissingSite[]): CostMissingSite[] {
  return [...sites].sort(
    (a, b) =>
      Number(a.hasRatePeriods) - Number(b.hasRatePeriods) ||
      b.sessionCount - a.sessionCount ||
      a.siteName.localeCompare(b.siteName),
  );
}

/**
 * Dashboard card (the stat card layout, warning tone): sessions without an
 * electricity cost are left out of profit. At most 5 site rows, then "<n> more
 * sites" to the sessions list of every site. One row per site: a site without
 * rate periods links to its rate settings; a site with rates names its
 * sessions without a cost, links to them in the sessions list and offers
 * Recalculate. Hidden from users who cannot edit sites.
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
  const ordered = orderCostMissingSites(sites);
  const shown = ordered.slice(0, MAX_COST_MISSING_SITE_ROWS);
  const hiddenCount = ordered.length - shown.length;

  return (
    <Card tone="warning" data-testid="cost-missing-notice">
      <CardHeader variant="stat">
        <CardTitle variant="stat">{t('dashboard.costMissingTitle')}</CardTitle>
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      </CardHeader>
      <CardContent className="text-sm">
        {t('dashboard.costMissingNotice', {
          count: sessionCount,
          revenue: formatCents(revenueCents, currency),
        })}
      </CardContent>
      <CardContent variant="list">
        <CardList>
          {shown.map((site) =>
            site.hasRatePeriods ? (
              <CardListItem
                key={site.siteId}
                className="flex-wrap items-center justify-between text-sm"
                data-testid="cost-missing-site"
              >
                <Link
                  to={costMissingSessionsPath(site.siteId)}
                  className="min-w-0 text-link hover:underline"
                >
                  {t('dashboard.costMissingSessions', {
                    count: site.sessionCount,
                    site: site.siteName,
                  })}
                </Link>
                <RecalculateElectricityCostAction siteId={site.siteId} siteName={site.siteName} />
              </CardListItem>
            ) : (
              <CardListLink
                key={site.siteId}
                to={electricityRatesPath(site.siteId)}
                className="text-sm text-link"
                data-testid="cost-missing-site"
              >
                {t('dashboard.costMissingNoRates', { site: site.siteName })} ({site.sessionCount})
              </CardListLink>
            ),
          )}
        </CardList>
      </CardContent>
      {hiddenCount > 0 && (
        <CardFooter variant="divided">
          <Link
            to={COST_MISSING_SESSIONS_PATH}
            className={buttonVariants({ variant: 'link', size: 'xs' })}
            data-testid="cost-missing-more"
          >
            {t('dashboard.costMissingMoreSites', { count: hiddenCount })}
          </Link>
        </CardFooter>
      )}
    </Card>
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
