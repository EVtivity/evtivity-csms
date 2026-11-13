// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { SavedMessage } from '@/components/saved-message';
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
  const storedAmount = settings?.[RESERVATION_KEY];
  const loaded = useMemo(
    () => ({
      amount: centsToMajorInput(
        typeof storedAmount === 'number' ? storedAmount : DEFAULT_RESERVATION_CENTS,
      ),
    }),
    [storedAmount],
  );
  const [error, setError] = useState<string | null>(null);
  // A settings reload replaces the value only while it is unedited.
  const [values, setValues, takeNextLoad] = useLoadedValues(loaded, () => {
    setError(null);
  });
  const { amount } = values;
  const setAmount = (value: string): void => {
    setValues({ amount: value });
  };

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
    const sent = { amount };
    mutation.mutate(cents, {
      onSuccess: () => {
        takeNextLoad(sent);
      },
    });
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
        <SavedMessage>{t('settings.fleetCreditReservationSaved')}</SavedMessage>
      )}
      {mutation.isError && (
        <p className="text-sm text-destructive">{t('settings.fleetCreditReservationSaveFailed')}</p>
      )}
    </form>
  );
}
