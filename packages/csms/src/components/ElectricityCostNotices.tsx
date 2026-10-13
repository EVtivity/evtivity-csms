// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { RecalculateButton } from '@/components/recalculate-button';
import { api, ApiError } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

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
