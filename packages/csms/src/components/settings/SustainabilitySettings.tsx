// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { SavedMessage } from '@/components/saved-message';

interface SustainabilitySettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function SustainabilitySettings({
  settings,
}: SustainabilitySettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const loaded = useMemo(() => {
    const s = (key: string): string => {
      const v = settings?.[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    return {
      gridEmissionFactor: s('sustainability.gridEmissionFactor') || '0.386',
      evEfficiency: s('sustainability.evEfficiency') || '3.3',
      gasolineEmissionFactor: s('sustainability.gasolineEmissionFactor') || '8.887',
      avgMpg: s('sustainability.avgMpg') || '25.4',
    };
  }, [settings]);
  // A settings reload replaces the values only while they are unedited.
  const [values, setValues, takeNextLoad] = useLoadedValues(loaded);
  const { gridEmissionFactor, evEfficiency, gasolineEmissionFactor, avgMpg } = values;
  const setGridEmissionFactor = (gridEmissionFactor: string): void => {
    setValues((v) => ({ ...v, gridEmissionFactor }));
  };
  const setEvEfficiency = (evEfficiency: string): void => {
    setValues((v) => ({ ...v, evEfficiency }));
  };
  const setGasolineEmissionFactor = (gasolineEmissionFactor: string): void => {
    setValues((v) => ({ ...v, gasolineEmissionFactor }));
  };
  const setAvgMpg = (avgMpg: string): void => {
    setValues((v) => ({ ...v, avgMpg }));
  };

  const sustainabilityMutation = useMutation({
    mutationFn: (vals: {
      gridEmissionFactor: string;
      evEfficiency: string;
      gasolineEmissionFactor: string;
      avgMpg: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/sustainability.gridEmissionFactor', {
          value: Number(vals.gridEmissionFactor),
        }),
        api.put('/v1/settings/sustainability.evEfficiency', { value: Number(vals.evEfficiency) }),
        api.put('/v1/settings/sustainability.gasolineEmissionFactor', {
          value: Number(vals.gasolineEmissionFactor),
        }),
        api.put('/v1/settings/sustainability.avgMpg', { value: Number(vals.avgMpg) }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sustainability')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.sustainabilityDescription')}</p>
        <div className="grid gap-4 sm:grid-cols-2 items-start">
          <div className="space-y-2">
            <Label htmlFor="grid-emission-factor" className="leading-6">
              {t('settings.gridEmissionFactor')}
            </Label>
            <DecimalInput
              id="grid-emission-factor"
              value={gridEmissionFactor}
              onChange={setGridEmissionFactor}
            />
            <p className="text-xs text-muted-foreground">{t('settings.gridEmissionFactorHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ev-efficiency" className="leading-6">
              {t('settings.evEfficiency')}
            </Label>
            <DecimalInput id="ev-efficiency" value={evEfficiency} onChange={setEvEfficiency} />
            <p className="text-xs text-muted-foreground">{t('settings.evEfficiencyHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="gasoline-emission-factor" className="leading-6">
              {t('settings.gasolineEmissionFactor')}
            </Label>
            <DecimalInput
              id="gasoline-emission-factor"
              value={gasolineEmissionFactor}
              onChange={setGasolineEmissionFactor}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.gasolineEmissionFactorHint')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="avg-mpg" className="leading-6">
              {t('settings.avgMpg')}
            </Label>
            <DecimalInput id="avg-mpg" value={avgMpg} onChange={setAvgMpg} />
            <p className="text-xs text-muted-foreground">{t('settings.avgMpgHint')}</p>
          </div>
        </div>
        <SaveButton
          isPending={sustainabilityMutation.isPending}
          type="button"
          onClick={() => {
            const sent = { gridEmissionFactor, evEfficiency, gasolineEmissionFactor, avgMpg };
            sustainabilityMutation.mutate(sent, {
              onSuccess: () => {
                takeNextLoad(sent);
              },
            });
          }}
        />
        {sustainabilityMutation.isSuccess &&
          JSON.stringify(sustainabilityMutation.variables) ===
            JSON.stringify({
              gridEmissionFactor,
              evEfficiency,
              gasolineEmissionFactor,
              avgMpg,
            }) && <SavedMessage />}
      </CardContent>
    </Card>
  );
}
