// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ParseKeys } from 'i18next';
import {
  COMPANY_BANK_ACCOUNT_HOLDER_KEY,
  COMPANY_BANK_NAME_KEY,
  COMPANY_BIC_KEY,
  COMPANY_IBAN_KEY,
  INVOICE_EPC_QR_ENABLED_KEY,
  INVOICE_PAYMENT_MAX_LENGTHS,
  INVOICE_PAYMENT_SETTING_KEYS,
  formatIban,
  normalizeInvoicePaymentSetting,
} from '@evtivity/lib/invoice-payment';
import type { InvoicePaymentSettingKey } from '@evtivity/lib/invoice-payment';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import { useHasCompanyWidePermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

type BankValues = Record<InvoicePaymentSettingKey, string>;

interface FieldSpec {
  key: InvoicePaymentSettingKey;
  id: string;
  label: ParseKeys;
  help?: ParseKeys;
  error: ParseKeys;
}

const FIELDS: FieldSpec[] = [
  {
    key: COMPANY_BANK_ACCOUNT_HOLDER_KEY,
    id: 'invoice-payment-holder',
    label: 'settings.invoicePaymentHolder',
    help: 'settings.invoicePaymentHolderHelp',
    error: 'settings.invoicePaymentTextInvalid',
  },
  {
    key: COMPANY_IBAN_KEY,
    id: 'invoice-payment-iban',
    label: 'settings.invoicePaymentIban',
    error: 'settings.invoicePaymentIbanInvalid',
  },
  {
    key: COMPANY_BIC_KEY,
    id: 'invoice-payment-bic',
    label: 'settings.invoicePaymentBic',
    error: 'settings.invoicePaymentBicInvalid',
  },
  {
    key: COMPANY_BANK_NAME_KEY,
    id: 'invoice-payment-bank-name',
    label: 'settings.invoicePaymentBankName',
    error: 'settings.invoicePaymentTextInvalid',
  },
];

function storedValues(settings: Record<string, unknown> | undefined): BankValues {
  const values = {} as BankValues;
  for (const key of INVOICE_PAYMENT_SETTING_KEYS) {
    const stored = settings?.[key];
    const text = typeof stored === 'string' ? stored : '';
    values[key] = key === COMPANY_IBAN_KEY ? formatIban(text) : text;
  }
  return values;
}

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * The bank details printed in the "Payment information" block of invoice
 * PDFs (account holder, IBAN, BIC, bank name) and the EPC QR code switch.
 * Without an IBAN the block is left out. Users without
 * `settings.system:write` or all-site access see the values but cannot
 * change them.
 */
export function InvoicePaymentSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasCompanyWidePermission('settings.system:write');
  const [values, setValues] = useState<BankValues>(() => storedValues(settings));
  const [epcQrEnabled, setEpcQrEnabled] = useState(
    () => settings?.[INVOICE_EPC_QR_ENABLED_KEY] !== false,
  );
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setValues(storedValues(settings));
    setEpcQrEnabled(settings?.[INVOICE_EPC_QR_ENABLED_KEY] !== false);
  }, [settings]);

  const mutation = useMutation({
    mutationFn: async (next: { values: BankValues; epcQrEnabled: boolean }) => {
      for (const key of INVOICE_PAYMENT_SETTING_KEYS) {
        await api.put(`/v1/settings/${key}`, { value: next.values[key] });
      }
      await api.put(`/v1/settings/${INVOICE_EPC_QR_ENABLED_KEY}`, { value: next.epcQrEnabled });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['branding'] });
    },
  });

  const normalized = {} as Record<InvoicePaymentSettingKey, string | null>;
  for (const key of INVOICE_PAYMENT_SETTING_KEYS) {
    normalized[key] = normalizeInvoicePaymentSetting(key, values[key]);
  }
  const invalid = INVOICE_PAYMENT_SETTING_KEYS.some((key) => normalized[key] == null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.invoicePayment')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (!canWrite || invalid) return;
            const next = {} as BankValues;
            for (const key of INVOICE_PAYMENT_SETTING_KEYS) next[key] = normalized[key] ?? '';
            mutation.mutate({ values: next, epcQrEnabled });
          }}
          noValidate
          className="space-y-4"
        >
          <p className="text-sm text-muted-foreground">{t('settings.invoicePaymentDescription')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {FIELDS.map((field) => {
              const error =
                submitted && normalized[field.key] == null
                  ? t(field.error, { max: INVOICE_PAYMENT_MAX_LENGTHS[field.key] })
                  : null;
              return (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={field.id} className="leading-6">
                    {t(field.label)}
                  </Label>
                  <Input
                    id={field.id}
                    // An IBAN is typed in groups of four.
                    maxLength={
                      field.key === COMPANY_IBAN_KEY ? 42 : INVOICE_PAYMENT_MAX_LENGTHS[field.key]
                    }
                    autoComplete="off"
                    value={values[field.key]}
                    disabled={!canWrite}
                    aria-invalid={error != null}
                    onChange={(e) => {
                      setValues((prev) => ({ ...prev, [field.key]: e.target.value }));
                    }}
                  />
                  {error != null && <p className="text-sm text-destructive">{error}</p>}
                  {field.help != null && (
                    <p className="text-xs text-muted-foreground">{t(field.help)}</p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-start gap-3">
            <Toggle
              id="invoice-payment-epc-qr"
              checked={epcQrEnabled}
              disabled={!canWrite}
              onCheckedChange={setEpcQrEnabled}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="invoice-payment-epc-qr">{t('settings.invoicePaymentEpcQr')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.invoicePaymentEpcQrHelp')}
              </p>
            </div>
          </div>

          {canWrite && <SaveButton isPending={mutation.isPending} />}
          {mutation.isSuccess && (
            <p className="text-sm text-success">{t('settings.invoicePaymentSaved')}</p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.invoicePaymentSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
