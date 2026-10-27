// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DATA_PLANS, isDataPlan } from '@evtivity/lib/station-data-plan';
import type { DataPlan } from '@evtivity/lib/station-data-plan';
import { SaveButton } from '@/components/save-button';
import { TabPanel } from '@/components/ui/tab-panel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

interface Props {
  siteId: string;
  /** The site's plan, null when not set. */
  dataPlan: DataPlan | null;
}

/** Site detail > Details: the data plan of the site's stations without their own plan or a SIM. */
export function SiteDataPlanCard({ siteId, dataPlan }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');
  const current = dataPlan ?? '';
  const [choice, setChoice] = useState<string>(current);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nextPlan: DataPlan | null = isDataPlan(choice) ? choice : null;

  const impact = useQuery({
    queryKey: ['sites', siteId, 'data-plan-impact', choice],
    queryFn: () =>
      api.get<{ stationsChanging: number }>(
        `/v1/sites/${siteId}/data-plan-impact${nextPlan != null ? `?dataPlan=${nextPlan}` : ''}`,
      ),
    enabled: confirmOpen,
    staleTime: 0,
  });

  const saveMutation = useMutation({
    mutationFn: (plan: DataPlan | null) => api.patch(`/v1/sites/${siteId}`, { dataPlan: plan }),
    onSuccess: () => {
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  return (
    <>
      <TabPanel title={t('dataPlan.title')} description={t('dataPlan.site.description')}>
        {canWrite ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid gap-2 sm:w-72">
              <Label htmlFor="site-data-plan">{t('dataPlan.title')}</Label>
              <Select
                id="site-data-plan"
                value={choice}
                onChange={(e) => {
                  setChoice(e.target.value);
                }}
              >
                <option value="">{t('dataPlan.notSet')}</option>
                {DATA_PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {t(`dataPlan.plans.${plan}`)}
                  </option>
                ))}
              </Select>
            </div>
            <SaveButton
              type="button"
              isPending={saveMutation.isPending}
              disabled={choice === current || saveMutation.isPending}
              onClick={() => {
                saveMutation.reset();
                setConfirmOpen(true);
              }}
            />
          </div>
        ) : (
          <p className="text-sm font-medium">
            {dataPlan != null ? t(`dataPlan.plans.${dataPlan}`) : t('dataPlan.notSet')}
          </p>
        )}
      </TabPanel>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('dataPlan.confirmTitle')}
        description={t('dataPlan.site.confirmDescription')}
        confirmLabel={t('common.save')}
        variant="default"
        isPending={saveMutation.isPending}
        onConfirm={() => {
          saveMutation.mutate(nextPlan);
          return false;
        }}
      >
        {impact.isLoading ? (
          <Spinner className="h-4 w-4" />
        ) : impact.data != null ? (
          <p className="text-sm font-medium">
            {t('dataPlan.site.stationsChanging', { count: impact.data.stationsChanging })}
          </p>
        ) : impact.isError ? (
          <p className="text-sm text-destructive">{getErrorMessage(impact.error, t)}</p>
        ) : null}
        {saveMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
        )}
      </ConfirmDialog>
    </>
  );
}
