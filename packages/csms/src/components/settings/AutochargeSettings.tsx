// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

const KEY = 'autocharge.enabled';

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * Autocharge (charge by plugging in), company-wide. A site can turn it on or
 * off for its own stations (Site > Details). Off by default.
 */
export function AutochargeSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(settings?.[KEY] === true);
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (value: boolean) => api.put(`/v1/settings/${KEY}`, { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err, value) => {
      setEnabled(!value);
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.autocharge')}</CardTitle>
        <CardDescription>{t('settings.autochargeDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('settings.autochargeEnabled')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.autochargeEnabledDesc')}</p>
          </div>
          <Toggle
            aria-label={t('settings.autochargeEnabled')}
            size="lg"
            checked={enabled}
            disabled={mutation.isPending}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              mutation.mutate(checked);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
