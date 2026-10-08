// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CancelButton } from '@/components/cancel-button';
import { EditButton } from '@/components/edit-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LanguageSelect, LANGUAGES } from '@/components/ui/language-select';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

/** The fleet billing profile as the API returns it on the fleet. */
export interface FleetBillingProfile {
  billingContactEmails: string[];
  billingLegalName: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
  billingTaxId: string | null;
  invoiceLanguage: string;
  paymentTermsDays: number | null;
  autoInvoice: boolean;
}

export interface FleetBillingProfileCardProps {
  fleet: { id: string; name: string } & Partial<FleetBillingProfile>;
}

export const MAX_BILLING_CONTACTS = 10;
const MAX_PAYMENT_TERMS_DAYS = 365;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormState {
  contacts: string;
  legalName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  taxId: string;
  language: string;
  paymentTerms: string;
  autoInvoice: boolean;
}

/** Splits the contacts field (one per line, or comma or semicolon separated). */
export function parseContactEmails(value: string): string[] {
  return value
    .split(/[\n,;]/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
}

function toForm(fleet: FleetBillingProfileCardProps['fleet']): FormState {
  return {
    contacts: (fleet.billingContactEmails ?? []).join('\n'),
    legalName: fleet.billingLegalName ?? '',
    street: fleet.billingStreet ?? '',
    city: fleet.billingCity ?? '',
    state: fleet.billingState ?? '',
    zip: fleet.billingZip ?? '',
    country: fleet.billingCountry ?? '',
    taxId: fleet.billingTaxId ?? '',
    language: fleet.invoiceLanguage ?? 'en',
    paymentTerms: fleet.paymentTermsDays == null ? '' : String(fleet.paymentTermsDays),
    autoInvoice: fleet.autoInvoice === true,
  };
}

const textOrNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** Fleet billing profile: who the fleet invoice goes to and how it is issued. */
export function FleetBillingProfileCard({
  fleet,
}: FleetBillingProfileCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('fleets:write');
  const [editing, setEditing] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [form, setForm] = useState<FormState>(() => toForm(fleet));

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/v1/fleets/${fleet.id}/billing-profile`, body),
    onSuccess: () => {
      toast({ title: t('fleets.billingProfile.updated'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleet.id] });
      setEditing(false);
      setHasSubmitted(false);
    },
    onError: (err) => {
      toast({
        title: t('fleets.billingProfile.updateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  const contacts = parseContactEmails(form.contacts);
  const errors: Partial<Record<'contacts' | 'paymentTerms', string>> = {};
  if (contacts.some((e) => !EMAIL_PATTERN.test(e))) {
    errors.contacts = t('fleets.billingProfile.contactsInvalid');
  } else if (contacts.length > MAX_BILLING_CONTACTS) {
    errors.contacts = t('fleets.billingProfile.contactsTooMany', { max: MAX_BILLING_CONTACTS });
  } else if (form.autoInvoice && contacts.length === 0) {
    errors.contacts = t('errors.FLEET_BILLING_CONTACT_REQUIRED');
  }
  const terms = form.paymentTerms.trim();
  if (terms !== '' && (!/^\d+$/.test(terms) || Number(terms) > MAX_PAYMENT_TERMS_DAYS)) {
    errors.paymentTerms = t('fleets.billingProfile.paymentTermsInvalid', {
      max: MAX_PAYMENT_TERMS_DAYS,
    });
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function startEdit(): void {
    setForm(toForm(fleet));
    setHasSubmitted(false);
    setEditing(true);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate({
      billingContactEmails: contacts,
      billingLegalName: textOrNull(form.legalName),
      billingStreet: textOrNull(form.street),
      billingCity: textOrNull(form.city),
      billingState: textOrNull(form.state),
      billingZip: textOrNull(form.zip),
      billingCountry: textOrNull(form.country),
      billingTaxId: textOrNull(form.taxId),
      invoiceLanguage: form.language,
      paymentTermsDays: terms === '' ? null : Number(terms),
      autoInvoice: form.autoInvoice,
    });
  }

  const textField = (
    key: 'legalName' | 'street' | 'city' | 'state' | 'zip' | 'country' | 'taxId',
    label: string,
    maxLength: number,
  ): React.JSX.Element => (
    <div className="space-y-2">
      <Label htmlFor={`billing-${key}`}>{label}</Label>
      <Input
        id={`billing-${key}`}
        value={form[key]}
        maxLength={maxLength}
        onChange={(e) => {
          set(key, e.target.value);
        }}
      />
    </div>
  );

  const languageLabel =
    LANGUAGES.find((l) => l.code === (fleet.invoiceLanguage ?? 'en'))?.label ?? 'English';
  const address = [
    fleet.billingStreet,
    [fleet.billingZip, fleet.billingCity].filter((v) => v != null && v !== '').join(' '),
    fleet.billingState,
    fleet.billingCountry,
  ].filter((v) => v != null && v !== '');
  const savedContacts = fleet.billingContactEmails ?? [];

  return (
    <Card data-testid="fleet-billing-profile">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t('fleets.billingProfile.title')}</CardTitle>
          <CardDescription>{t('fleets.billingProfile.description')}</CardDescription>
        </div>
        {canWrite && !editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
      </CardHeader>
      <CardContent className="text-sm">
        {editing ? (
          <form onSubmit={handleSave} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="billing-contacts">{t('fleets.billingProfile.contacts')}</Label>
              <textarea
                id="billing-contacts"
                value={form.contacts}
                onChange={(e) => {
                  set('contacts', e.target.value);
                }}
                className={`flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ${hasSubmitted && errors.contacts != null ? 'border-destructive' : ''}`}
              />
              <p className="text-xs text-muted-foreground">
                {t('fleets.billingProfile.contactsHelp')}
              </p>
              {hasSubmitted && errors.contacts != null && (
                <p className="text-sm text-destructive">{errors.contacts}</p>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {textField('legalName', t('fleets.billingProfile.legalName'), 255)}
              {textField('taxId', t('fleets.billingProfile.taxId'), 50)}
              {textField('street', t('fleets.billingProfile.street'), 255)}
              {textField('city', t('fleets.billingProfile.city'), 100)}
              {textField('state', t('fleets.billingProfile.state'), 100)}
              {textField('zip', t('fleets.billingProfile.zip'), 20)}
              {textField('country', t('fleets.billingProfile.country'), 100)}
              <div className="space-y-2">
                <Label htmlFor="billing-language">
                  {t('fleets.billingProfile.invoiceLanguage')}
                </Label>
                <LanguageSelect
                  id="billing-language"
                  value={form.language}
                  onChange={(v) => {
                    set('language', v);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing-terms">{t('fleets.billingProfile.paymentTerms')}</Label>
                <Input
                  id="billing-terms"
                  inputMode="numeric"
                  value={form.paymentTerms}
                  placeholder={t('fleets.billingProfile.paymentTermsDefault')}
                  className={
                    hasSubmitted && errors.paymentTerms != null ? 'border-destructive' : ''
                  }
                  onChange={(e) => {
                    set('paymentTerms', e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('fleets.billingProfile.paymentTermsHelp')}
                </p>
                {hasSubmitted && errors.paymentTerms != null && (
                  <p className="text-sm text-destructive">{errors.paymentTerms}</p>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <Toggle
                  id="billing-auto-invoice"
                  checked={form.autoInvoice}
                  aria-label={t('fleets.billingProfile.autoInvoice')}
                  onCheckedChange={(checked) => {
                    set('autoInvoice', checked);
                  }}
                />
                <Label htmlFor="billing-auto-invoice">
                  {t('fleets.billingProfile.autoInvoice')}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('fleets.billingProfile.autoInvoiceHelp')}
              </p>
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
          <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <dt className="text-muted-foreground">{t('fleets.billingProfile.contacts')}</dt>
              <dd className="font-medium break-all">
                {savedContacts.length > 0
                  ? savedContacts.join(', ')
                  : t('fleets.billingProfile.noContacts')}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fleets.billingProfile.billTo')}</dt>
              <dd className="font-medium">
                <div>{fleet.billingLegalName ?? fleet.name}</div>
                {address.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fleets.billingProfile.taxId')}</dt>
              <dd className="font-medium">{fleet.billingTaxId ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t('fleets.billingProfile.invoiceLanguage')}
              </dt>
              <dd className="font-medium">{languageLabel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fleets.billingProfile.paymentTerms')}</dt>
              <dd className="font-medium">
                {fleet.paymentTermsDays == null
                  ? t('fleets.billingProfile.paymentTermsDefault')
                  : String(fleet.paymentTermsDays)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fleets.billingProfile.autoInvoice')}</dt>
              <dd>
                <Badge variant={fleet.autoInvoice === true ? 'success' : 'outline'}>
                  {fleet.autoInvoice === true ? t('fleets.billing.on') : t('fleets.billing.off')}
                </Badge>
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
