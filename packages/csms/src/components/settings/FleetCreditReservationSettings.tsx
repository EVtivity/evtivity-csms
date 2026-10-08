// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import {
  centsToMajorInput,
  formatCurrencyAmount,
  parseMajorInputToCents,
} from '@evtivity/lib/currency';

const RESERVATION_KEY = 'fleet.creditReservationCents';
// DEFAULT_FLEET_CREDIT_RESERVATION_CENTS in @evtivity/database.
const DEFAULT_RESERVATION_CENTS = 5000;
// The settings route accepts at most this (MAX_FLEET_CREDIT_RESERVATION_CENTS).
const MAX_RESERVATION_CENTS = 100_000_000;

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * Fleet credit reservation (charge on account with a credit limit): the slice
 * of the fleet credit an account session reserves at its start and adds while
 * it charges (`fleet.creditReservationCents`, features/fleet-billing.md).
 */
export function FleetCreditReservationSettings({ settings }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { currency } = useCompanyCurrency();
  // Typed in the currency (major units), stored in cents.
  const [amount, setAmount] = useState(centsToMajorInput(DEFAULT_RESERVATION_CENTS));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = settings?.[RESERVATION_KEY];
    if (typeof stored === 'number') setAmount(centsToMajorInput(stored));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (value: number) => api.put(`/v1/settings/${RESERVATION_KEY}`, { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  function handleSave(): void {
    const cents = parseMajorInputToCents(amount);
    if (cents == null || cents < 1) {
      setError(t('settings.fleetCreditReservationInvalid'));
      return;
    }
    if (cents > MAX_RESERVATION_CENTS) {
      setError(
        t('settings.fleetCreditReservationTooHigh', {
          max:
            currency != null
              ? formatCurrencyAmount(MAX_RESERVATION_CENTS, currency, i18n.language)
              : centsToMajorInput(MAX_RESERVATION_CENTS),
        }),
      );
      return;
    }
    setError(null);
    mutation.mutate(cents);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
      noValidate
      className="space-y-4 rounded-lg border p-4"
    >
      <div className="space-y-2 sm:max-w-sm">
        <Label htmlFor="fleet-credit-reservation" className="leading-6">
          {t('settings.fleetCreditReservation', { currency: currency ?? '...' })}
        </Label>
        <Input
          id="fleet-credit-reservation"
          type="number"
          min={0.01}
          max={MAX_RESERVATION_CENTS / 100}
          step="0.01"
          value={amount}
          aria-invalid={error != null}
          onChange={(e) => {
            setAmount(e.target.value);
          }}
        />
        {error != null && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">{t('settings.fleetCreditReservationHelp')}</p>
      </div>

      <SaveButton isPending={mutation.isPending} />

      {mutation.isSuccess && (
        <p className="text-sm text-success">{t('settings.fleetCreditReservationSaved')}</p>
      )}
      {mutation.isError && (
        <p className="text-sm text-destructive">{t('settings.fleetCreditReservationSaveFailed')}</p>
      )}
    </form>
  );
}
