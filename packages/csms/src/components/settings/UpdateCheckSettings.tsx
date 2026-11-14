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
import { useSavedToast } from '@/components/saved-message';
import { useLoadedValues } from '@/hooks/use-loaded-values';

const KEY = 'system.updateCheckEnabled';

interface Props {
  settings: Record<string, unknown> | undefined;
  /** settings.system:write: without it the switch is read-only. */
  canWrite: boolean;
}

/**
 * Whether the worker reads the latest CSMS release from the EVtivity website
 * once a day for the update notice. On by default (a missing row reads on).
 * Off: the server contacts the website for nothing and no notice shows.
 */
export function UpdateCheckSettings({ settings, canWrite }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const savedToast = useSavedToast();
  const queryClient = useQueryClient();
  // A settings reload replaces the shown value only while no save is pending.
  const [values, setValues, takeNextLoad] = useLoadedValues({
    enabled: settings?.[KEY] !== false,
  });
  const enabled = values.enabled;
  const setEnabled = (value: boolean): void => {
    setValues({ enabled: value });
  };

  const mutation = useMutation({
    mutationFn: (value: boolean) => api.put(`/v1/settings/${KEY}`, { value }),
    onSuccess: (_data, value) => {
      takeNextLoad({ enabled: value });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      savedToast();
    },
    onError: (err, value) => {
      setEnabled(!value);
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.updateCheck.title')}</CardTitle>
        <CardDescription>{t('settings.updateCheck.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('settings.updateCheck.enabled')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.updateCheck.enabledDesc')}</p>
          </div>
          <ConfirmToggle
            aria-label={t('settings.updateCheck.enabled')}
            label={t('settings.updateCheck.enabled')}
            offDescription={t('settings.updateCheck.offEffect')}
            size="lg"
            checked={enabled}
            disabled={!canWrite || mutation.isPending}
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
