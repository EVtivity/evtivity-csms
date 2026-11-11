// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';

interface MarketingSettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function MarketingSettings({ settings }: MarketingSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const loaded = useMemo(() => {
    const s = (key: string): string => {
      const v = settings?.[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    return { gtagPortal: s('marketing.gtagPortal'), gtagCsms: s('marketing.gtagCsms') };
  }, [settings]);
  // A settings reload replaces the values only while they are unedited.
  const [values, setValues, takeNextLoad] = useLoadedValues(loaded);
  const { gtagPortal, gtagCsms } = values;
  const setGtagPortal = (gtagPortal: string): void => {
    setValues((v) => ({ ...v, gtagPortal }));
  };
  const setGtagCsms = (gtagCsms: string): void => {
    setValues((v) => ({ ...v, gtagCsms }));
  };

  const marketingMutation = useMutation({
    mutationFn: (vals: { gtagPortal: string; gtagCsms: string }) =>
      Promise.all([
        api.put('/v1/settings/marketing.gtagPortal', { value: vals.gtagPortal }),
        api.put('/v1/settings/marketing.gtagCsms', { value: vals.gtagCsms }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.marketing')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.marketingDescription')}</p>

        <div className="grid gap-4 sm:grid-cols-2 items-start">
          <div className="space-y-2">
            <Label htmlFor="gtag-portal" className="leading-6">
              {t('settings.gtagPortal')}
            </Label>
            <Input
              id="gtag-portal"
              value={gtagPortal}
              onChange={(e) => {
                setGtagPortal(e.target.value);
              }}
              placeholder="G-XXXXXXXXXX"
            />
            <p className="text-xs text-muted-foreground">{t('settings.gtagHint')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gtag-csms" className="leading-6">
              {t('settings.gtagCsms')}
            </Label>
            <Input
              id="gtag-csms"
              value={gtagCsms}
              onChange={(e) => {
                setGtagCsms(e.target.value);
              }}
              placeholder="G-XXXXXXXXXX"
            />
            <p className="text-xs text-muted-foreground">{t('settings.gtagHint')}</p>
          </div>
        </div>

        <SaveButton
          isPending={marketingMutation.isPending}
          type="button"
          onClick={() => {
            const sent = { gtagPortal, gtagCsms };
            marketingMutation.mutate(sent, {
              onSuccess: () => {
                takeNextLoad(sent);
              },
            });
          }}
        />
        {marketingMutation.isSuccess && (
          <p className="text-sm text-success">{t('settings.marketingSaved')}</p>
        )}
        {marketingMutation.isError && (
          <p className="text-sm text-destructive">{t('settings.marketingSaveFailed')}</p>
        )}
      </CardContent>
    </Card>
  );
}
