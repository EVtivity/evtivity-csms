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
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { useCompanyTaxBasis } from '@/hooks/use-company-tax-basis';
import { DEFAULT_TAX_BASIS } from '@evtivity/lib/price-display';
import { SavedMessage } from '@/components/saved-message';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';

interface Props {
  settings: Record<string, unknown> | undefined;
}

export function ReservationSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { currency } = useCompanyCurrency();
  // The fee is entered in the company tax basis, like tariff prices.
  const taxBasis = useCompanyTaxBasis() ?? DEFAULT_TAX_BASIS;
  // Typed in the currency (major units), stored in cents. The fee is net: the
  // station tariff's tax rate is added when it is charged.
  const loaded = useMemo(() => {
    const buf = settings?.['reservation.bufferMinutes'];
    const win = settings?.['reservation.cancellationWindowMinutes'];
    const fee = settings?.['reservation.cancellationFeeCents'];
    const max = settings?.['reservation.maxHours'];
    return {
      bufferMinutes: buf != null ? Number(buf).toString() : '15',
      cancellationWindowMinutes: win != null ? Number(win).toString() : '5',
      cancellationFee: centsToMajorInput(fee != null ? Number(fee) : 0),
      maxHours: max != null ? Number(max).toString() : '3',
    };
  }, [settings]);
  // A settings reload replaces the values only while they are unedited.
  const [values, setValues, takeNextLoad] = useLoadedValues(loaded);
  const { bufferMinutes, cancellationWindowMinutes, cancellationFee, maxHours } = values;
  const setBufferMinutes = (bufferMinutes: string): void => {
    setValues((v) => ({ ...v, bufferMinutes }));
  };
  const setCancellationWindowMinutes = (cancellationWindowMinutes: string): void => {
    setValues((v) => ({ ...v, cancellationWindowMinutes }));
  };
  const setCancellationFee = (cancellationFee: string): void => {
    setValues((v) => ({ ...v, cancellationFee }));
  };
  const setMaxHours = (maxHours: string): void => {
    setValues((v) => ({ ...v, maxHours }));
  };

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

  const maxHoursMutation = useMutation({
    mutationFn: (value: number) => api.put('/v1/settings/reservation.maxHours', { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const isPending =
    bufferMutation.isPending ||
    windowMutation.isPending ||
    feeMutation.isPending ||
    maxHoursMutation.isPending;
  const isSuccess =
    bufferMutation.isSuccess ||
    windowMutation.isSuccess ||
    feeMutation.isSuccess ||
    maxHoursMutation.isSuccess;
  const isError =
    bufferMutation.isError ||
    windowMutation.isError ||
    feeMutation.isError ||
    maxHoursMutation.isError;

  function handleSave(): void {
    const buf = parseInt(bufferMinutes, 10);
    const win = parseInt(cancellationWindowMinutes, 10);
    const fee = parseMajorInputToCents(cancellationFee);
    const max = parseInt(maxHours, 10);

    const sent = values;
    void Promise.all([
      bufferMutation.mutateAsync(Number.isNaN(buf) ? 15 : Math.max(0, buf)),
      windowMutation.mutateAsync(Number.isNaN(win) ? 5 : Math.max(0, win)),
      feeMutation.mutateAsync(fee ?? 0),
      maxHoursMutation.mutateAsync(Number.isNaN(max) ? 3 : Math.max(0, max)),
    ]).then(
      () => {
        takeNextLoad(sent);
      },
      () => {
        // The failed save shows its error note; the edits stay.
      },
    );
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
          <div className="grid gap-6 sm:grid-cols-2 items-start">
            <div className="space-y-2">
              <Label htmlFor="reservation-buffer-minutes" className="leading-6">
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
              <Label htmlFor="reservation-cancellation-window" className="leading-6">
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
              <Label htmlFor="reservation-cancellation-fee" className="leading-6">
                {t('settings.reservationCancellationFee', {
                  currency: currency ?? '...',
                  context: taxBasis,
                })}
              </Label>
              <Input
                id="reservation-cancellation-fee"
                type="number"
                min={0}
                step="0.01"
                value={cancellationFee}
                onChange={(e) => {
                  setCancellationFee(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.reservationCancellationFeeHelp', { context: taxBasis })}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reservation-max-hours" className="leading-6">
                {t('settings.reservationMaxHours')}
              </Label>
              <Input
                id="reservation-max-hours"
                type="number"
                min={0}
                value={maxHours}
                onChange={(e) => {
                  setMaxHours(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.reservationMaxHoursHelp')}
              </p>
            </div>
          </div>

          <SaveButton isPending={isPending} />

          {isSuccess && <SavedMessage>{t('settings.reservationSettingsSaved')}</SavedMessage>}
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
