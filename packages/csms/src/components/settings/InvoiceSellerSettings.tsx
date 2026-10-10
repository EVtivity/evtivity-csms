// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ParseKeys } from 'i18next';
import {
  COMPANY_INVOICE_EMAIL_KEY,
  COMPANY_INVOICE_PHONE_KEY,
  COMPANY_REGISTRATION_NUMBER_KEY,
  COMPANY_TAX_ID_KEY,
  COMPANY_TAX_ID_LABEL_KEY,
  INVOICE_SELLER_MAX_LENGTHS,
  INVOICE_SELLER_SETTING_KEYS,
  normalizeInvoiceSellerSetting,
} from '@evtivity/lib/invoice-seller';
import type { InvoiceSellerSettingKey } from '@evtivity/lib/invoice-seller';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useHasCompanyWidePermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

type SellerValues = Record<InvoiceSellerSettingKey, string>;

interface FieldSpec {
  key: InvoiceSellerSettingKey;
  id: string;
  label: ParseKeys;
  help?: ParseKeys;
  type?: 'email' | 'tel';
}

const FIELDS: FieldSpec[] = [
  {
    key: COMPANY_TAX_ID_KEY,
    id: 'invoice-seller-tax-id',
    label: 'settings.invoiceSellerTaxId',
    help: 'settings.invoiceSellerTaxIdHelp',
  },
  {
    key: COMPANY_TAX_ID_LABEL_KEY,
    id: 'invoice-seller-tax-id-label',
    label: 'settings.invoiceSellerTaxIdLabel',
    help: 'settings.invoiceSellerTaxIdLabelHelp',
  },
  {
    key: COMPANY_REGISTRATION_NUMBER_KEY,
    id: 'invoice-seller-registration-number',
    label: 'settings.invoiceSellerRegistrationNumber',
  },
  {
    key: COMPANY_INVOICE_EMAIL_KEY,
    id: 'invoice-seller-email',
    label: 'settings.invoiceSellerEmail',
    type: 'email',
  },
  {
    key: COMPANY_INVOICE_PHONE_KEY,
    id: 'invoice-seller-phone',
    label: 'settings.invoiceSellerPhone',
    type: 'tel',
  },
];

function storedValues(settings: Record<string, unknown> | undefined): SellerValues {
  const values = {} as SellerValues;
  for (const key of INVOICE_SELLER_SETTING_KEYS) {
    const stored = settings?.[key];
    values[key] = typeof stored === 'string' ? stored : '';
  }
  return values;
}

interface Props {
  settings: Record<string, unknown> | undefined;
}

/**
 * The seller details printed in the "From" block of invoice and credit note
 * PDFs under the company name and address: tax ID and its label, company
 * registration number, invoice contact email and phone. Users without
 * `settings.system:write` or all-site access see the values but cannot
 * change them.
 */
export function InvoiceSellerSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasCompanyWidePermission('settings.system:write');
  const [values, setValues] = useState<SellerValues>(() => storedValues(settings));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setValues(storedValues(settings));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: async (next: SellerValues) => {
      for (const key of INVOICE_SELLER_SETTING_KEYS) {
        await api.put(`/v1/settings/${key}`, { value: next[key] });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['branding'] });
    },
  });

  const normalized = {} as Record<InvoiceSellerSettingKey, string | null>;
  for (const key of INVOICE_SELLER_SETTING_KEYS) {
    normalized[key] = normalizeInvoiceSellerSetting(key, values[key]);
  }
  const invalid = INVOICE_SELLER_SETTING_KEYS.some((key) => normalized[key] == null);

  function errorFor(key: InvoiceSellerSettingKey): string | null {
    if (!submitted || normalized[key] != null) return null;
    if (key === COMPANY_INVOICE_EMAIL_KEY) {
      const trimmed = values[key].trim();
      if (trimmed.length <= INVOICE_SELLER_MAX_LENGTHS[key]) {
        return t('settings.invoiceSellerEmailInvalid');
      }
    }
    return t('settings.invoiceSellerInvalid', { max: INVOICE_SELLER_MAX_LENGTHS[key] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.invoiceSeller')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (!canWrite || invalid) return;
            const next = {} as SellerValues;
            for (const key of INVOICE_SELLER_SETTING_KEYS) next[key] = normalized[key] ?? '';
            mutation.mutate(next);
          }}
          noValidate
          className="space-y-4"
        >
          <p className="text-sm text-muted-foreground">{t('settings.invoiceSellerDescription')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {FIELDS.map((field) => {
              const error = errorFor(field.key);
              return (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={field.id} className="leading-6">
                    {t(field.label)}
                  </Label>
                  <Input
                    id={field.id}
                    type={field.type ?? 'text'}
                    maxLength={INVOICE_SELLER_MAX_LENGTHS[field.key]}
                    placeholder={
                      field.key === COMPANY_TAX_ID_LABEL_KEY
                        ? t('settings.invoiceSellerTaxId')
                        : undefined
                    }
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

          {canWrite && <SaveButton isPending={mutation.isPending} />}
          {mutation.isSuccess && (
            <p className="text-sm text-success">{t('settings.invoiceSellerSaved')}</p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.invoiceSellerSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
