// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

const PAYMENT_TERMS_KEY = 'invoice.paymentTermsDays';
const DEFAULT_PAYMENT_TERMS_DAYS = 30;
// The settings route accepts at most this (MAX_INVOICE_PAYMENT_TERMS_DAYS).
const MAX_PAYMENT_TERMS_DAYS = 365;
const RUN_DAY_KEY = 'fleet.invoiceRunDay';
const DEFAULT_RUN_DAY = 1;
// The settings route accepts 1 to this (MAX_FLEET_INVOICE_RUN_DAY): every month has it.
const MAX_RUN_DAY = 28;

interface InvoiceSettingsValues {
  days: number;
  runDay: number;
}

function parseWholeNumber(text: string, min: number, max: number): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * Invoice settings: the days from issue to the due date of a new invoice, and
 * the day of the month from which the monthly run invoices fleets.
 */
export function InvoiceSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(String(DEFAULT_PAYMENT_TERMS_DAYS));
  const [runDay, setRunDay] = useState(String(DEFAULT_RUN_DAY));
  const [error, setError] = useState<string | null>(null);
  const [runDayError, setRunDayError] = useState<string | null>(null);

  useEffect(() => {
    const stored = settings?.[PAYMENT_TERMS_KEY];
    if (typeof stored === 'number') setDays(String(stored));
    const storedRunDay = settings?.[RUN_DAY_KEY];
    if (typeof storedRunDay === 'number') setRunDay(String(storedRunDay));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: async (values: InvoiceSettingsValues) => {
      await api.put(`/v1/settings/${PAYMENT_TERMS_KEY}`, { value: values.days });
      await api.put(`/v1/settings/${RUN_DAY_KEY}`, { value: values.runDay });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  function handleSave(): void {
    const daysValue = parseWholeNumber(days, 0, MAX_PAYMENT_TERMS_DAYS);
    const runDayValue = parseWholeNumber(runDay, 1, MAX_RUN_DAY);
    setError(
      daysValue == null
        ? t('settings.invoicePaymentTermsDaysInvalid', { max: MAX_PAYMENT_TERMS_DAYS })
        : null,
    );
    setRunDayError(
      runDayValue == null ? t('settings.fleetInvoiceRunDayInvalid', { max: MAX_RUN_DAY }) : null,
    );
    if (daysValue == null || runDayValue == null) return;
    mutation.mutate({ days: daysValue, runDay: runDayValue });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.invoiceSettings')}</CardTitle>
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
          <div className="space-y-2 sm:max-w-sm">
            <Label htmlFor="invoice-payment-terms-days" className="leading-6">
              {t('settings.invoicePaymentTermsDays')}
            </Label>
            <Input
              id="invoice-payment-terms-days"
              type="number"
              min={0}
              max={MAX_PAYMENT_TERMS_DAYS}
              step="1"
              value={days}
              aria-invalid={error != null}
              onChange={(e) => {
                setDays(e.target.value);
              }}
            />
            {error != null && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">
              {t('settings.invoicePaymentTermsDaysHelp')}
            </p>
          </div>

          <div className="space-y-2 sm:max-w-sm">
            <Label htmlFor="fleet-invoice-run-day" className="leading-6">
              {t('settings.fleetInvoiceRunDay')}
            </Label>
            <Input
              id="fleet-invoice-run-day"
              type="number"
              min={1}
              max={MAX_RUN_DAY}
              step="1"
              value={runDay}
              aria-invalid={runDayError != null}
              onChange={(e) => {
                setRunDay(e.target.value);
              }}
            />
            {runDayError != null && <p className="text-sm text-destructive">{runDayError}</p>}
            <p className="text-xs text-muted-foreground">{t('settings.fleetInvoiceRunDayHelp')}</p>
          </div>

          <SaveButton isPending={mutation.isPending} />

          {mutation.isSuccess && (
            <p className="text-sm text-success">{t('settings.invoiceSettingsSaved')}</p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.invoiceSettingsSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
