// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { TabPanel } from '@/components/ui/tab-panel';
import { TabsContent } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

interface Site {
  id: string;
  freeVendEnabled: boolean;
  freeVendTemplateId21: string | null;
  freeVendTemplateId16: string | null;
  freeVendRestoreTemplateId21?: string | null;
  freeVendRestoreTemplateId16?: string | null;
}

export interface SiteFreeVendTabProps {
  site: Site;
  siteId: string;
}

export function SiteFreeVendTab({ site, siteId }: SiteFreeVendTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Free vend stops payment at the site: the API needs payments:write too.
  const canWriteSite = useHasPermission('sites:write');
  const canWritePayments = useHasPermission('payments:write');
  const canWrite = canWriteSite && canWritePayments;
  // Free vend changes what every driver at the site pays: confirm both ways.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const enabling = !site.freeVendEnabled;
  const showDisabledNote =
    !site.freeVendEnabled &&
    (site.freeVendRestoreTemplateId21 != null || site.freeVendRestoreTemplateId16 != null);

  const freeVendMutation = useMutation({
    mutationFn: (enabled: boolean) => api.post(`/v1/sites/${siteId}/free-vend`, { enabled }),
    onSuccess: () => {
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
  });

  return (
    <TabsContent value="free-vend">
      <TabPanel
        title={t('sites.freeVend')}
        description={showDisabledNote ? t('sites.freeVendDisabledNote') : undefined}
      >
        <div className="flex items-center justify-between">
          <div className="grid gap-1">
            <Label>{t('sites.freeVend')}</Label>
            <p className="text-xs text-muted-foreground">{t('sites.freeVendDescription')}</p>
          </div>
          <Toggle
            aria-label={t('sites.freeVend')}
            size="lg"
            checked={site.freeVendEnabled}
            onCheckedChange={() => {
              freeVendMutation.reset();
              setConfirmOpen(true);
            }}
            disabled={!canWrite || freeVendMutation.isPending}
          />
        </div>
        {freeVendMutation.isError && !confirmOpen && (
          <p className="mt-3 text-sm text-destructive">
            {getErrorMessage(freeVendMutation.error, t)}
          </p>
        )}
      </TabPanel>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={enabling ? t('sites.enableFreeVend') : t('sites.disableFreeVend')}
        description={
          enabling ? t('sites.confirmEnableFreeVend') : t('sites.confirmDisableFreeVend')
        }
        confirmLabel={enabling ? t('sites.enableFreeVend') : t('sites.disableFreeVend')}
        variant={enabling ? 'destructive' : 'default'}
        isPending={freeVendMutation.isPending}
        onConfirm={() => {
          freeVendMutation.mutate(enabling);
          return false;
        }}
      >
        {freeVendMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(freeVendMutation.error, t)}</p>
        )}
      </ConfirmDialog>

      {site.freeVendTemplateId21 != null && (
        <TabPanel title={t('sites.freeVendOcpp21Template')}>
          <Link
            to={`/station-configurations/${site.freeVendTemplateId21}`}
            className="text-link hover:underline text-sm"
          >
            {t('sites.freeVendViewTemplate')}
          </Link>
        </TabPanel>
      )}

      {site.freeVendTemplateId16 != null && (
        <TabPanel title={t('sites.freeVendOcpp16Template')} bodyClassName="space-y-2">
          <Link
            to={`/station-configurations/${site.freeVendTemplateId16}`}
            className="text-link hover:underline text-sm"
          >
            {t('sites.freeVendViewTemplate')}
          </Link>
          <p className="text-xs text-muted-foreground mt-2">{t('sites.freeVendOcpp16Note')}</p>
        </TabPanel>
      )}
      {(site.freeVendRestoreTemplateId21 != null || site.freeVendRestoreTemplateId16 != null) && (
        <TabPanel title={t('sites.freeVendRestoreTitle')} bodyClassName="space-y-2">
          <p className="text-xs text-muted-foreground">{t('sites.freeVendRestoreDescription')}</p>
          {(
            [
              ['freeVendOcpp21Template', site.freeVendRestoreTemplateId21],
              ['freeVendOcpp16Template', site.freeVendRestoreTemplateId16],
            ] as const
          ).map(([labelKey, templateId]) =>
            templateId != null ? (
              <div key={labelKey} className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="text-muted-foreground">{t(`sites.${labelKey}`)}</span>
                <Link
                  to={`/station-configurations/${templateId}`}
                  className="text-link hover:underline"
                >
                  {t('sites.freeVendViewTemplate')}
                </Link>
              </div>
            ) : null,
          )}
        </TabPanel>
      )}
    </TabsContent>
  );
}
