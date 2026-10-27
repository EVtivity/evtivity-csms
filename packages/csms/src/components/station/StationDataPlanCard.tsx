// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DATA_PLANS, isDataPlan } from '@evtivity/lib/station-data-plan';
import type { ChargingKind, DataPlan, DataPlanSource } from '@evtivity/lib/station-data-plan';
import { SaveButton } from '@/components/save-button';
import { TabPanel } from '@/components/ui/tab-panel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

export interface StationDataPlanState {
  id: string;
  /** The station's own choice, null when it uses the SIM, site or default rule. */
  dataPlan: DataPlan | null;
  effectiveDataPlan: DataPlan;
  dataPlanSource: DataPlanSource;
  chargingKind: ChargingKind;
}

interface Props {
  station: StationDataPlanState;
}

/** Station detail > Configurations: the data plan the station runs and its own choice. */
export function StationDataPlanCard({ station }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');
  const current = station.dataPlan ?? '';
  const [choice, setChoice] = useState<string>(current);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (dataPlan: DataPlan | null) =>
      api.patch(`/v1/stations/${station.id}`, { dataPlan }),
    onSuccess: () => {
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['stations', station.id] });
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  return (
    <>
      <TabPanel
        title={t('dataPlan.title')}
        description={t('dataPlan.station.description')}
        bodyClassName="space-y-4"
      >
        <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('dataPlan.planLabel')}</dt>
            <dd className="font-medium">{t(`dataPlan.plans.${station.effectiveDataPlan}`)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('dataPlan.sourceLabel')}</dt>
            <dd className="font-medium">{t(`dataPlan.sources.${station.dataPlanSource}`)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('dataPlan.kindLabel')}</dt>
            <dd className="font-medium">{t(`dataPlan.kinds.${station.chargingKind}`)}</dd>
          </div>
        </dl>
        {canWrite && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid gap-2 sm:w-72">
              <Label htmlFor="station-data-plan">{t('dataPlan.station.choice')}</Label>
              <Select
                id="station-data-plan"
                value={choice}
                onChange={(e) => {
                  setChoice(e.target.value);
                }}
              >
                {DATA_PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {t(`dataPlan.plans.${plan}`)}
                  </option>
                ))}
                <option value="">{t('dataPlan.useSitePlan')}</option>
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
        )}
      </TabPanel>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('dataPlan.confirmTitle')}
        description={t('dataPlan.station.confirmDescription')}
        confirmLabel={t('common.save')}
        variant="default"
        isPending={saveMutation.isPending}
        onConfirm={() => {
          saveMutation.mutate(isDataPlan(choice) ? choice : null);
          return false;
        }}
      >
        {saveMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
        )}
      </ConfirmDialog>
    </>
  );
}
