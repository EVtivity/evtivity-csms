// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface Props {
  settings: Record<string, unknown> | undefined;
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        {description != null && (
          <p
            className={`text-xs ${disabled === true ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          onChange(!checked);
        }}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-primary' : 'bg-muted'}`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}

export function SecurityMfaSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [emailEnabled, setEmailEnabled] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [smsEnabled, setSmsEnabled] = useState(false);

  // Check if SMTP and Twilio are configured
  const { data: allSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });

  const smtpConfigured =
    allSettings != null &&
    typeof allSettings['smtp.host'] === 'string' &&
    allSettings['smtp.host'] !== '';

  const twilioConfigured =
    allSettings != null &&
    typeof allSettings['twilio.accountSid'] === 'string' &&
    allSettings['twilio.accountSid'] !== '';

  useEffect(() => {
    if (settings == null) return;
    setEmailEnabled(settings['security.mfa.emailEnabled'] === true);
    setTotpEnabled(settings['security.mfa.totpEnabled'] === true);
    setSmsEnabled(settings['security.mfa.smsEnabled'] === true);
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (vals: { emailEnabled: boolean; totpEnabled: boolean; smsEnabled: boolean }) =>
      api.put<{ success: boolean }>('/v1/security/mfa', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['security-settings'] });
    },
  });

  function handleSave(): void {
    mutation.mutate({ emailEnabled, totpEnabled, smsEnabled });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.mfa')}</CardTitle>
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
          <p className="text-sm text-muted-foreground">{t('settings.mfaDescription')}</p>

          <ToggleRow
            label={t('settings.mfaEmail')}
            {...(!smtpConfigured ? { description: t('settings.mfaEmailDisabledHint') } : {})}
            checked={emailEnabled}
            disabled={!smtpConfigured}
            onChange={setEmailEnabled}
          />

          <ToggleRow
            label={t('settings.mfaTotp')}
            checked={totpEnabled}
            onChange={setTotpEnabled}
          />

          <ToggleRow
            label={t('settings.mfaSms')}
            {...(!twilioConfigured ? { description: t('settings.mfaSmsDisabledHint') } : {})}
            checked={smsEnabled}
            disabled={!twilioConfigured}
            onChange={setSmsEnabled}
          />

          <SaveButton isPending={mutation.isPending} />

          {mutation.isSuccess && <p className="text-sm text-green-600">{t('settings.mfaSaved')}</p>}
          {mutation.isError && (
            <p className="text-sm text-destructive">{t('settings.mfaSaveFailed')}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
