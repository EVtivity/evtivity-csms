// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface Props {
  settings: Record<string, unknown> | undefined;
}

export function ReservationSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [bufferMinutes, setBufferMinutes] = useState('15');
  const [cancellationWindowMinutes, setCancellationWindowMinutes] = useState('5');
  const [cancellationFeeCents, setCancellationFeeCents] = useState('0');

  useEffect(() => {
    if (settings == null) return;
    const buf = settings['reservation.bufferMinutes'];
    if (buf != null) setBufferMinutes(Number(buf).toString());
    const win = settings['reservation.cancellationWindowMinutes'];
    if (win != null) setCancellationWindowMinutes(Number(win).toString());
    const fee = settings['reservation.cancellationFeeCents'];
    if (fee != null) setCancellationFeeCents(Number(fee).toString());
  }, [settings]);

  const bufferMutation = useMutation({
    mutationFn: (value: number) => api.put('/v1/settings/reservation.bufferMinutes', { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const windowMutation = useMutation({
    mutationFn: (value: number) =>
      api.put('/v1/settings/reservation.cancellationWindowMinutes', { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const feeMutation = useMutation({
    mutationFn: (value: number) =>
      api.put('/v1/settings/reservation.cancellationFeeCents', { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const isPending = bufferMutation.isPending || windowMutation.isPending || feeMutation.isPending;
  const isSuccess = bufferMutation.isSuccess || windowMutation.isSuccess || feeMutation.isSuccess;
  const isError = bufferMutation.isError || windowMutation.isError || feeMutation.isError;

  function handleSave(): void {
    const buf = parseInt(bufferMinutes, 10);
    const win = parseInt(cancellationWindowMinutes, 10);
    const fee = parseInt(cancellationFeeCents, 10);

    void Promise.all([
      bufferMutation.mutateAsync(Number.isNaN(buf) ? 15 : Math.max(0, buf)),
      windowMutation.mutateAsync(Number.isNaN(win) ? 5 : Math.max(0, win)),
      feeMutation.mutateAsync(Number.isNaN(fee) ? 0 : Math.max(0, fee)),
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.reservationSettings')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          noValidate
          className="space-y-4"
        >
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="reservation-buffer-minutes">
                {t('settings.reservationBufferMinutes')}
              </Label>
              <Input
                id="reservation-buffer-minutes"
                type="number"
                min={0}
                value={bufferMinutes}
                onChange={(e) => {
                  setBufferMinutes(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.reservationBufferMinutesHelp')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reservation-cancellation-window">
                {t('settings.reservationCancellationWindowMinutes')}
              </Label>
              <Input
                id="reservation-cancellation-window"
                type="number"
                min={0}
                value={cancellationWindowMinutes}
                onChange={(e) => {
                  setCancellationWindowMinutes(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.reservationCancellationWindowMinutesHelp')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reservation-cancellation-fee">
                {t('settings.reservationCancellationFeeCents')}
              </Label>
              <Input
                id="reservation-cancellation-fee"
                type="number"
                min={0}
                value={cancellationFeeCents}
                onChange={(e) => {
                  setCancellationFeeCents(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.reservationCancellationFeeCentsHelp')}
              </p>
            </div>
          </div>

          <SaveButton isPending={isPending} />

          {isSuccess && (
            <p className="text-sm text-success">{t('settings.reservationSettingsSaved')}</p>
          )}
          {isError && (
            <p className="text-sm text-destructive">
              {t('settings.reservationSettingsSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
