// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CancelButton } from '@/components/cancel-button';
import { EditButton } from '@/components/edit-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

/** The driver billing address, from GET /v1/drivers/:id/billing-address. */
export interface DriverBillingAddress {
  billingName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
}

type FieldKey = keyof DriverBillingAddress;

/** The fields in form order, with the column widths of the API. */
const FIELDS = [
  { key: 'billingName', label: 'drivers.billingAddress.name', maxLength: 255 },
  { key: 'billingStreet', label: 'drivers.billingAddress.street', maxLength: 255 },
  { key: 'billingCity', label: 'drivers.billingAddress.city', maxLength: 100 },
  { key: 'billingState', label: 'drivers.billingAddress.state', maxLength: 100 },
  { key: 'billingZip', label: 'drivers.billingAddress.zip', maxLength: 20 },
  { key: 'billingCountry', label: 'drivers.billingAddress.country', maxLength: 100 },
] as const satisfies readonly { key: FieldKey; label: string; maxLength: number }[];

type FormState = Record<FieldKey, string>;

function toForm(address: DriverBillingAddress | undefined): FormState {
  const form = {} as FormState;
  for (const { key } of FIELDS) form[key] = address?.[key] ?? '';
  return form;
}

export interface DriverBillingAddressCardProps {
  driver: { id: string; firstName: string; lastName: string; erasedAt?: string | null };
}

/** The bill-to block of the invoices a fleet addresses to this driver. */
export function DriverBillingAddressCard({
  driver,
}: DriverBillingAddressCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // An erased driver is an anonymized stub that cannot be re-addressed.
  const canWrite = useHasPermission('drivers:write') && driver.erasedAt == null;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(() => toForm(undefined));
  const queryKey = ['drivers', driver.id, 'billing-address'];

  const { data: address } = useQuery({
    queryKey,
    queryFn: () => api.get<DriverBillingAddress>(`/v1/drivers/${driver.id}/billing-address`),
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (body: Record<FieldKey, string | null>) =>
      api.patch<DriverBillingAddress>(`/v1/drivers/${driver.id}/billing-address`, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
      toast({ title: t('drivers.billingAddress.updated'), variant: 'success' });
      setEditing(false);
    },
    onError: (err) => {
      toast({
        title: t('drivers.billingAddress.updateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  function startEdit(): void {
    setForm(toForm(address));
    setEditing(true);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    const body = {} as Record<FieldKey, string | null>;
    for (const { key } of FIELDS) {
      const value = form[key].trim();
      body[key] = value === '' ? null : value;
    }
    mutation.mutate(body);
  }

  const lines = [
    address?.billingStreet,
    [address?.billingZip, address?.billingCity].filter((v) => v != null && v !== '').join(' '),
    address?.billingState,
    address?.billingCountry,
  ].filter((v): v is string => v != null && v !== '');
  const name = address?.billingName ?? `${driver.firstName} ${driver.lastName}`;

  return (
    <Card data-testid="driver-billing-address">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t('drivers.billingAddress.title')}</CardTitle>
          <CardDescription>{t('drivers.billingAddress.description')}</CardDescription>
        </div>
        {canWrite && !editing && address != null && (
          <EditButton label={t('common.edit')} onClick={startEdit} />
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {editing ? (
          <form onSubmit={handleSave} noValidate className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {FIELDS.map(({ key, label, maxLength }) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`driver-${key}`}>{t(label)}</Label>
                  <Input
                    id={`driver-${key}`}
                    value={form[key]}
                    maxLength={maxLength}
                    {...(key === 'billingName'
                      ? { placeholder: `${driver.firstName} ${driver.lastName}` }
                      : {})}
                    onChange={(e) => {
                      setForm((prev) => ({ ...prev, [key]: e.target.value }));
                    }}
                  />
                  {key === 'billingName' && (
                    <p className="text-xs text-muted-foreground">
                      {t('drivers.billingAddress.nameHelp')}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditing(false);
                }}
              />
              <SaveButton isPending={mutation.isPending} />
            </div>
          </form>
        ) : (
          <dl>
            <dt className="text-muted-foreground">{t('drivers.billingAddress.billTo')}</dt>
            <dd className="font-medium">
              <div>{name}</div>
              {lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
              {address != null && lines.length === 0 && (
                <div className="font-normal text-muted-foreground">
                  {t('drivers.billingAddress.empty')}
                </div>
              )}
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
