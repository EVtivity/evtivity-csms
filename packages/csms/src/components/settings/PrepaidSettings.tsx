// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const THRESHOLD_KEY = 'prepaid.lowCreditThresholdCents';
const DEFAULT_THRESHOLD_CENTS = 500;
// The settings route accepts at most this (MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS).
const MAX_THRESHOLD_CENTS = 100_000_000;

interface Props {
  settings: Record<string, unknown> | undefined;
  /** Shown read-only: the settings are company-wide (all-site access to edit). */
  readOnly?: boolean;
}

/**
 * Prepaid card settings: the balance below which a debit sends the driver the
 * low credit notice (`prepaid.LowCredit`). 0 turns the notice off.
 */
export function PrepaidSettings({ settings, readOnly = false }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { currency } = useCompanyCurrency();
  // Typed in the currency (major units), stored in cents.
  const storedThreshold = settings?.[THRESHOLD_KEY];
  const loaded = useMemo(
    () => ({
      threshold: centsToMajorInput(
        typeof storedThreshold === 'number' ? storedThreshold : DEFAULT_THRESHOLD_CENTS,
      ),
    }),
    [storedThreshold],
  );
  const [error, setError] = useState<string | null>(null);
  // A settings reload replaces the value only while it is unedited.
  const [values, setValues, takeNextLoad] = useLoadedValues(loaded, () => {
    setError(null);
  });
  const { threshold } = values;
  const setThreshold = (value: string): void => {
    setValues({ threshold: value });
  };

  const mutation = useMutation({
    mutationFn: (value: number) => api.put(`/v1/settings/${THRESHOLD_KEY}`, { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  function handleSave(): void {
    const cents = parseMajorInputToCents(threshold);
    if (cents == null || cents < 0) {
      setError(t('settings.prepaidLowCreditThresholdInvalid'));
      return;
    }
    if (cents > MAX_THRESHOLD_CENTS) {
      setError(
        t('settings.prepaidLowCreditThresholdTooHigh', {
          max:
            currency != null
              ? formatCurrencyAmount(MAX_THRESHOLD_CENTS, currency, i18n.language)
              : centsToMajorInput(MAX_THRESHOLD_CENTS),
        }),
      );
      return;
    }
    setError(null);
    const sent = { threshold };
    mutation.mutate(cents, {
      onSuccess: () => {
        takeNextLoad(sent);
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.prepaidSettings')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!readOnly) handleSave();
          }}
          noValidate
          className="space-y-4"
        >
          <div className="space-y-2 sm:max-w-sm">
            <Label htmlFor="prepaid-low-credit-threshold" className="leading-6">
              {t('settings.prepaidLowCreditThreshold', { currency: currency ?? '...' })}
            </Label>
            <Input
              id="prepaid-low-credit-threshold"
              type="number"
              min={0}
              max={MAX_THRESHOLD_CENTS / 100}
              step="0.01"
              value={threshold}
              aria-invalid={error != null}
              disabled={readOnly}
              onChange={(e) => {
                setThreshold(e.target.value);
              }}
            />
            {error != null && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">
              {t('settings.prepaidLowCreditThresholdHelp')}
            </p>
          </div>

          {readOnly ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.companyWideSettingsReadOnly')}
            </p>
          ) : (
            <SaveButton isPending={mutation.isPending} />
          )}

          {mutation.isSuccess && <SavedMessage>{t('settings.prepaidSettingsSaved')}</SavedMessage>}
          {mutation.isError && (
            <p className="text-sm text-destructive">{t('settings.prepaidSettingsSaveFailed')}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
