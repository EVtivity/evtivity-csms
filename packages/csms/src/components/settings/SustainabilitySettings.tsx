// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface SustainabilitySettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function SustainabilitySettings({
  settings,
}: SustainabilitySettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [gridEmissionFactor, setGridEmissionFactor] = useState('0.386');
  const [evEfficiency, setEvEfficiency] = useState('3.3');
  const [gasolineEmissionFactor, setGasolineEmissionFactor] = useState('8.887');
  const [avgMpg, setAvgMpg] = useState('25.4');

  useEffect(() => {
    if (settings == null) return;
    const s = (key: string): string => {
      const v = settings[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    setGridEmissionFactor(s('sustainability.gridEmissionFactor') || '0.386');
    setEvEfficiency(s('sustainability.evEfficiency') || '3.3');
    setGasolineEmissionFactor(s('sustainability.gasolineEmissionFactor') || '8.887');
    setAvgMpg(s('sustainability.avgMpg') || '25.4');
  }, [settings]);

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
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="grid-emission-factor">{t('settings.gridEmissionFactor')}</Label>
            <DecimalInput
              id="grid-emission-factor"
              value={gridEmissionFactor}
              onChange={setGridEmissionFactor}
            />
            <p className="text-xs text-muted-foreground">{t('settings.gridEmissionFactorHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ev-efficiency">{t('settings.evEfficiency')}</Label>
            <DecimalInput id="ev-efficiency" value={evEfficiency} onChange={setEvEfficiency} />
            <p className="text-xs text-muted-foreground">{t('settings.evEfficiencyHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="gasoline-emission-factor">{t('settings.gasolineEmissionFactor')}</Label>
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
            <Label htmlFor="avg-mpg">{t('settings.avgMpg')}</Label>
            <DecimalInput id="avg-mpg" value={avgMpg} onChange={setAvgMpg} />
            <p className="text-xs text-muted-foreground">{t('settings.avgMpgHint')}</p>
          </div>
        </div>
        <SaveButton
          isPending={sustainabilityMutation.isPending}
          type="button"
          onClick={() => {
            sustainabilityMutation.mutate({
              gridEmissionFactor,
              evEfficiency,
              gasolineEmissionFactor,
              avgMpg,
            });
          }}
        />
      </CardContent>
    </Card>
  );
}
