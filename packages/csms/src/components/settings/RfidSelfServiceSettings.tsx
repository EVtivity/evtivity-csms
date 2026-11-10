// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

const KEY = 'portal.rfidSelfServiceEnabled';

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * Whether drivers manage their own RFID cards in the portal and the mobile
 * app. On by default (a missing row reads on). Off: drivers only see their
 * cards, and operators manage them on the Tokens page.
 */
export function RfidSelfServiceSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setEnabled(settings?.[KEY] !== false);
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
        <CardTitle>{t('settings.rfidCards')}</CardTitle>
        <CardDescription>{t('settings.rfidCardsDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('settings.rfidSelfServiceEnabled')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.rfidSelfServiceEnabledDesc')}
            </p>
          </div>
          <ConfirmToggle
            aria-label={t('settings.rfidSelfServiceEnabled')}
            label={t('settings.rfidSelfServiceEnabled')}
            offDescription={t('settings.rfidSelfServiceOffEffect')}
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
