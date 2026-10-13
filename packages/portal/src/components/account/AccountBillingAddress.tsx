// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoNote } from '@/components/ui/info-note';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

/** The driver billing address (GET /v1/portal/auth/me `billingAddress`). */
export interface DriverBillingAddress {
  billingName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
}

type FieldKey = keyof DriverBillingAddress;

interface PortalMe {
  billing?: { invoicedTo?: 'fleet' | 'member' | null };
  billingAddress?: DriverBillingAddress;
}

/** The fields in form order, with the column widths of the API. */
const FIELDS: { key: FieldKey; label: string; maxLength: number; autoComplete: string }[] = [
  { key: 'billingName', label: 'name', maxLength: 255, autoComplete: 'name' },
  { key: 'billingStreet', label: 'street', maxLength: 255, autoComplete: 'street-address' },
  { key: 'billingZip', label: 'zip', maxLength: 20, autoComplete: 'postal-code' },
  { key: 'billingCity', label: 'city', maxLength: 100, autoComplete: 'address-level2' },
  { key: 'billingState', label: 'state', maxLength: 100, autoComplete: 'address-level1' },
  { key: 'billingCountry', label: 'country', maxLength: 100, autoComplete: 'country-name' },
];

type FormState = Record<FieldKey, string>;

function toForm(address: DriverBillingAddress | undefined): FormState {
  const form = {} as FormState;
  for (const { key } of FIELDS) form[key] = address?.[key] ?? '';
  return form;
}

/** True when no address line is set (the name alone is not an address). */
function isAddressEmpty(address: DriverBillingAddress | undefined): boolean {
  return FIELDS.every(({ key }) => key === 'billingName' || (address?.[key] ?? null) == null);
}

/**
 * The bill-to block of the invoices a fleet addresses to the driver. Shared
 * query key with the driver billing (same endpoint), so one request serves both.
 */
export function AccountBillingAddress(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const driver = useAuth((s) => s.driver);
  const { data } = useQuery({
    queryKey: ['portal-driver-billing'],
    queryFn: () => api.get<PortalMe>('/v1/portal/auth/me'),
    staleTime: 60_000,
  });
  const address = data?.billingAddress;
  const [form, setForm] = useState<FormState>(() => toForm(address));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(toForm(address));
  }, [address]);

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMessage('');
    setSaving(true);
    const body = {} as Record<FieldKey, string | null>;
    for (const { key } of FIELDS) {
      const value = form[key].trim();
      body[key] = value === '' ? null : value;
    }
    try {
      await api.patch('/v1/portal/driver/billing-address', body);
      await queryClient.invalidateQueries({ queryKey: ['portal-driver-billing'] });
      setMessage(t('billingAddress.updated'));
    } catch (err) {
      setMessage(getErrorMessage(err, t, 'billingAddress.updateFailed'));
    } finally {
      setSaving(false);
    }
  }

  const fullName = `${driver?.firstName ?? ''} ${driver?.lastName ?? ''}`.trim();
  const showNudge = data?.billing?.invoicedTo === 'member' && isAddressEmpty(address);

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      className="space-y-4"
      data-testid="account-billing-address"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('billingAddress.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('billingAddress.description')}</p>
      </div>
      {showNudge && <InfoNote>{t('billingAddress.nudge')}</InfoNote>}
      {message !== '' && <p className="text-sm text-muted-foreground">{message}</p>}
      {FIELDS.map(({ key, label, maxLength, autoComplete }) => (
        <div key={key} className="space-y-2">
          <label htmlFor={`bill-${key}`} className="block text-sm font-medium leading-6">
            {t(`billingAddress.${label}`)}
          </label>
          <Input
            id={`bill-${key}`}
            value={form[key]}
            maxLength={maxLength}
            autoComplete={autoComplete}
            disabled={address == null}
            {...(key === 'billingName' && fullName !== '' ? { placeholder: fullName } : {})}
            onChange={(e) => {
              setForm((prev) => ({ ...prev, [key]: e.target.value }));
            }}
          />
          {key === 'billingName' && (
            <p className="text-xs text-muted-foreground">{t('billingAddress.nameHelp')}</p>
          )}
        </div>
      ))}
      <Button type="submit" className="w-full" disabled={saving || address == null}>
        {saving ? t('common.saving') : t('common.save')}
      </Button>
    </form>
  );
}
