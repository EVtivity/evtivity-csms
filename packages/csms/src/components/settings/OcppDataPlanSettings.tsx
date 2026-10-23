// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DATA_PLANS,
  DATA_PLAN_DEFAULTS,
  dataPlanIntervalRange,
  dataPlanSettingKeys,
  validateDataPlanSetting,
} from '@evtivity/lib/station-data-plan';
import type { DataPlan, DataPlanSettingKeys } from '@evtivity/lib/station-data-plan';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { useTab } from '@/hooks/use-tab';
import { useLoadedValues } from '@/hooks/use-loaded-values';

type PlanField = keyof DataPlanSettingKeys;

type PlanForm = Record<PlanField, string>;

const NUMBER_FIELDS: readonly PlanField[] = [
  'heartbeatInterval',
  'csmsPingInterval',
  'acMeterValueInterval',
  'dcMeterValueInterval',
  'clockAlignedInterval',
];

/** The form values of a plan: the stored setting, else the shipped value. */
export function planFormFromSettings(
  plan: DataPlan,
  settings: Record<string, unknown> | undefined,
): PlanForm {
  const keys = dataPlanSettingKeys(plan);
  const d = DATA_PLAN_DEFAULTS[plan];
  const shipped: PlanForm = {
    heartbeatInterval: String(d.heartbeatInterval),
    csmsPingInterval: String(d.csmsPingInterval),
    clockAlignedInterval: String(d.clockAlignedInterval),
    alignedMeasurands: d.alignedMeasurands,
    txEndedMeasurands: d.txEndedMeasurands,
    acMeterValueInterval: String(d.ac.meterValueInterval),
    acSampledMeasurands: d.ac.sampledMeasurands,
    dcMeterValueInterval: String(d.dc.meterValueInterval),
    dcSampledMeasurands: d.dc.sampledMeasurands,
  };
  const form = { ...shipped };
  for (const field of Object.keys(keys) as PlanField[]) {
    const stored = settings?.[keys[field]];
    if (typeof stored === 'number' || typeof stored === 'string') form[field] = String(stored);
  }
  return form;
}

function settingValue(field: PlanField, raw: string): number | string {
  if (!NUMBER_FIELDS.includes(field)) return raw.trim();
  const n = Number(raw);
  return raw.trim() === '' || !Number.isFinite(n) ? raw : n;
}

interface PlanTabProps {
  plan: DataPlan;
  settings: Record<string, unknown> | undefined;
}

function DataPlanTab({ plan, settings }: PlanTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keys = dataPlanSettingKeys(plan);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [values, setValues] = useLoadedValues(planFormFromSettings(plan, settings), () => {
    setHasSubmitted(false);
  });

  // The help text under each field states the range; the API checks the same rules.
  const errors: Partial<Record<PlanField, string>> = {};
  for (const field of Object.keys(keys) as PlanField[]) {
    if (validateDataPlanSetting(keys[field], settingValue(field, values[field])) != null) {
      errors[field] = t('validation.invalidValue');
    }
  }

  const saveMutation = useMutation({
    mutationFn: (form: PlanForm) =>
      Promise.all(
        (Object.keys(keys) as PlanField[]).map((field) =>
          api.put(`/v1/settings/${keys[field]}`, { value: settingValue(field, form[field]) }),
        ),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const id = (field: PlanField): string => `ocpp-${plan}-${field}`;
  const ranges = {
    heartbeat: dataPlanIntervalRange('heartbeatInterval'),
    ping: dataPlanIntervalRange('csmsPingInterval'),
    meter: dataPlanIntervalRange('meterValueInterval'),
    aligned: dataPlanIntervalRange('clockAlignedInterval'),
  };

  function field(
    name: PlanField,
    label: string,
    help: string,
    type: 'number' | 'text',
  ): React.JSX.Element {
    const error = hasSubmitted ? errors[name] : undefined;
    return (
      <div className="grid gap-2">
        <Label htmlFor={id(name)}>{label}</Label>
        <Input
          id={id(name)}
          type={type}
          {...(type === 'number' ? { min: 0, step: 1 } : {})}
          value={values[name]}
          className={error != null ? 'border-destructive' : ''}
          onChange={(e) => {
            const next = e.target.value;
            setValues((prev) => ({ ...prev, [name]: next }));
          }}
        />
        <p className="text-xs text-muted-foreground">{help}</p>
        {error != null && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('dataPlan.settings.heartbeatTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 max-w-lg">
            {field(
              'heartbeatInterval',
              t('settings.ocppHeartbeatInterval'),
              t('dataPlan.settings.heartbeatIntervalHelp', ranges.heartbeat),
              'number',
            )}
            {field(
              'csmsPingInterval',
              t('dataPlan.settings.csmsPingInterval'),
              t('dataPlan.settings.csmsPingIntervalHelp', ranges.ping),
              'number',
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dataPlan.settings.chargingTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('dataPlan.settings.chargingDescription')}
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="grid gap-4 content-start">
              <h3 className="text-sm font-medium">{t('dataPlan.settings.acStations')}</h3>
              {field(
                'acMeterValueInterval',
                t('settings.ocppMeterValueInterval'),
                t('dataPlan.settings.meterValueIntervalHelp', ranges.meter),
                'number',
              )}
              {field(
                'acSampledMeasurands',
                t('settings.ocppSampledMeasurands'),
                t('dataPlan.settings.sampledMeasurandsHelp'),
                'text',
              )}
            </div>
            <div className="grid gap-4 content-start">
              <h3 className="text-sm font-medium">{t('dataPlan.settings.dcStations')}</h3>
              {field(
                'dcMeterValueInterval',
                t('settings.ocppMeterValueInterval'),
                t('dataPlan.settings.meterValueIntervalHelp', ranges.meter),
                'number',
              )}
              {field(
                'dcSampledMeasurands',
                t('settings.ocppSampledMeasurands'),
                t('dataPlan.settings.sampledMeasurandsHelp'),
                'text',
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dataPlan.settings.idleTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 max-w-lg">
            {field(
              'clockAlignedInterval',
              t('settings.ocppClockAlignedInterval'),
              t('dataPlan.settings.clockAlignedIntervalHelp', ranges.aligned),
              'number',
            )}
            {field(
              'alignedMeasurands',
              t('settings.ocppAlignedMeasurands'),
              t('dataPlan.settings.alignedMeasurandsHelp'),
              'text',
            )}
            {field(
              'txEndedMeasurands',
              t('settings.ocppTxEndedMeasurands'),
              t('dataPlan.settings.txEndedMeasurandsHelp'),
              'text',
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <SaveButton
          isPending={saveMutation.isPending}
          type="button"
          onClick={() => {
            setHasSubmitted(true);
            if (Object.keys(errors).length > 0) return;
            saveMutation.mutate(values);
          }}
        />
        {saveMutation.isSuccess && <p className="text-sm text-success">{t('common.saved')}</p>}
        {saveMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
        )}
      </div>
    </div>
  );
}

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * Settings > Integrations & Features > OCPP: the station values of each data
 * plan, one tab and one Save per plan.
 */
export function OcppDataPlanSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [planTab, setPlanTab] = useTab('wifi_or_wired', 'plan');
  const active = (DATA_PLANS as readonly string[]).includes(planTab) ? planTab : 'wifi_or_wired';

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('dataPlan.settings.description')}</p>
      <Tabs value={active} onValueChange={setPlanTab}>
        <TabsList>
          {DATA_PLANS.map((plan) => (
            <TabsTrigger key={plan} value={plan}>
              {t(`dataPlan.plans.${plan}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {DATA_PLANS.map((plan) => (
          <TabsContent key={plan} value={plan} className="mt-4" keepMounted>
            <DataPlanTab plan={plan} settings={settings} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
