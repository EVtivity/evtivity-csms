// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { useLoadedValues } from '@/hooks/use-loaded-values';

const KEY = 'stationUnits.enabled';

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * The Station section of Integrations & Features: Enable Station Units. Off
 * by default (a missing row reads off). Off: no station shows the Uses Station
 * Units switch or any unit control. The server refuses turning it off while a
 * station still uses units.
 */
export function StationUnitsSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // A settings reload replaces the shown value only while no save is pending.
  const [values, setValues, takeNextLoad] = useLoadedValues({
    enabled: settings?.[KEY] === true,
  });
  const enabled = values.enabled;

  const mutation = useMutation({
    mutationFn: (value: boolean) => api.put(`/v1/settings/${KEY}`, { value }),
    onSuccess: (_data, value) => {
      takeNextLoad({ enabled: value });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err, value) => {
      setValues({ enabled: !value });
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.station.title')}</CardTitle>
        <CardDescription>{t('settings.station.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('settings.station.unitsEnabled')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.station.unitsEnabledDesc')}
            </p>
          </div>
          <ConfirmToggle
            aria-label={t('settings.station.unitsEnabled')}
            label={t('settings.station.unitsEnabled')}
            offDescription={t('settings.station.unitsOffEffect')}
            size="lg"
            checked={enabled}
            disabled={mutation.isPending}
            onCheckedChange={(checked) => {
              setValues({ enabled: checked });
              mutation.mutate(checked);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
