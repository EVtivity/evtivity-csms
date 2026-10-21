// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Toggle } from '@/components/ui/toggle';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import type { MfaRequiredMode } from '@evtivity/lib/mfa-config';

/** The MFA settings in effect: the `mfa` field of GET /v1/security/settings. */
export interface SecurityMfaSwitches {
  emailEnabled: boolean;
  totpEnabled: boolean;
  smsEnabled: boolean;
  required?: MfaRequiredMode;
  requiredRoles?: string[];
  /** Passkeys and security keys as a second factor (default on). */
  webauthnEnabled?: boolean;
  /** Passwordless sign-in with a passkey (default off; needs webauthnEnabled). */
  passkeyLoginEnabled?: boolean;
  /** Every driver must have MFA at portal sign-in (default off). */
  requireDrivers?: boolean;
}

const REQUIRED_LABELS: Record<MfaRequiredMode, string> = {
  off: 'settings.mfaRequiredOff',
  all: 'settings.mfaRequiredAll',
  roles: 'settings.mfaRequiredRoles',
};

/** GET /v1/security/settings: the stored security.* keys plus the parsed values in effect. */
export interface SecuritySettingsResponse extends Record<string, unknown> {
  mfa?: SecurityMfaSwitches;
  /** Every role name, the choices of the required roles list. */
  roleNames?: string[];
}

interface Props {
  settings: SecuritySettingsResponse | undefined;
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
        <Label className="leading-6">{label}</Label>
        {description != null && (
          <p
            className={`text-xs ${disabled === true ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {description}
          </p>
        )}
      </div>
      <Toggle
        aria-label={label}
        size="lg"
        checked={checked}
        onCheckedChange={() => {
          onChange(!checked);
        }}
        disabled={disabled}
      />
    </div>
  );
}

export function SecurityMfaSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [emailEnabled, setEmailEnabled] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [required, setRequired] = useState<MfaRequiredMode>('off');
  const [requiredRoles, setRequiredRoles] = useState<string[]>([]);
  const [webauthnEnabled, setWebauthnEnabled] = useState(true);
  const [passkeyLoginEnabled, setPasskeyLoginEnabled] = useState(false);
  const [requireDrivers, setRequireDrivers] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

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
    // The server sends the switches in effect, defaults for unset keys included.
    const { mfa } = settings;
    setEmailEnabled(mfa?.emailEnabled === true);
    setTotpEnabled(mfa?.totpEnabled === true);
    setSmsEnabled(mfa?.smsEnabled === true);
    setRequired(mfa?.required ?? 'off');
    setRequiredRoles(mfa?.requiredRoles ?? []);
    setWebauthnEnabled(mfa?.webauthnEnabled !== false);
    setPasskeyLoginEnabled(mfa?.passkeyLoginEnabled === true);
    setRequireDrivers(mfa?.requireDrivers === true);
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (vals: {
      emailEnabled: boolean;
      totpEnabled: boolean;
      smsEnabled: boolean;
      required: MfaRequiredMode;
      requiredRoles?: string[];
      webauthnEnabled: boolean;
      passkeyLoginEnabled: boolean;
      requireDrivers: boolean;
    }) => api.put<{ success: boolean }>('/v1/security/mfa', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['security-settings'] });
      // The sign-in page reads the passkey sign-in switch from the public settings.
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
    },
  });

  const validationErrors: Record<string, string> = {};
  if (required === 'roles' && requiredRoles.length === 0) {
    validationErrors['requiredRoles'] = t('settings.mfaRequiredRolesEmpty');
  }
  if (required !== 'off' && !emailEnabled && !totpEnabled) {
    validationErrors['required'] = t('settings.mfaRequiredNoMethod');
  }
  if (requireDrivers && !emailEnabled && !totpEnabled) {
    validationErrors['requireDrivers'] = t('settings.mfaRequiredNoMethod');
  }

  function handleSave(): void {
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    mutation.mutate({
      emailEnabled,
      totpEnabled,
      smsEnabled,
      required,
      // Only the roles mode sends the list, so switching modes keeps the stored roles.
      ...(required === 'roles' ? { requiredRoles } : {}),
      webauthnEnabled,
      // Passkey sign-in needs passkeys, so it is saved off while they are off.
      passkeyLoginEnabled: webauthnEnabled && passkeyLoginEnabled,
      requireDrivers,
    });
  }

  function toggleRole(name: string, checked: boolean): void {
    setRequiredRoles((prev) =>
      checked ? [...prev.filter((r) => r !== name), name] : prev.filter((r) => r !== name),
    );
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

          <ToggleRow
            label={t('settings.mfaWebauthn')}
            description={t('settings.mfaWebauthnDescription')}
            checked={webauthnEnabled}
            onChange={setWebauthnEnabled}
          />

          <ToggleRow
            label={t('settings.mfaPasskeyLogin')}
            description={
              webauthnEnabled
                ? t('settings.mfaPasskeyLoginDescription')
                : t('settings.mfaPasskeyLoginDisabledHint')
            }
            checked={webauthnEnabled && passkeyLoginEnabled}
            disabled={!webauthnEnabled}
            onChange={setPasskeyLoginEnabled}
          />

          <div className="space-y-2 rounded-lg border p-4">
            <Label htmlFor="mfa-required-select" className="leading-6">
              {t('settings.mfaRequired')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('settings.mfaRequiredDescription')}</p>
            <Select
              id="mfa-required-select"
              value={required}
              onChange={(e) => {
                setRequired(e.target.value as MfaRequiredMode);
              }}
              className={hasSubmitted && validationErrors['required'] ? 'border-destructive' : ''}
            >
              {(Object.keys(REQUIRED_LABELS) as MfaRequiredMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {t(REQUIRED_LABELS[mode] as never)}
                </option>
              ))}
            </Select>
            {hasSubmitted && validationErrors['required'] != null && (
              <p className="text-sm text-destructive">{validationErrors['required']}</p>
            )}
            {required === 'roles' && (
              <fieldset className="space-y-2 pt-2">
                <legend className="text-sm font-medium leading-6">
                  {t('settings.mfaRequiredRolesLabel')}
                </legend>
                {(settings?.roleNames ?? []).map((name) => (
                  <label key={name} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={requiredRoles.includes(name)}
                      onChange={(e) => {
                        toggleRole(name, e.target.checked);
                      }}
                    />
                    <span className="capitalize">{name}</span>
                  </label>
                ))}
                {hasSubmitted && validationErrors['requiredRoles'] != null && (
                  <p className="text-sm text-destructive">{validationErrors['requiredRoles']}</p>
                )}
              </fieldset>
            )}
          </div>

          <div className="space-y-2">
            <ToggleRow
              label={t('settings.mfaRequireDrivers')}
              description={t('settings.mfaRequireDriversDescription')}
              checked={requireDrivers}
              onChange={setRequireDrivers}
            />
            {hasSubmitted && validationErrors['requireDrivers'] != null && (
              <p className="text-sm text-destructive">{validationErrors['requireDrivers']}</p>
            )}
          </div>

          <SaveButton isPending={mutation.isPending} />

          {mutation.isSuccess && <p className="text-sm text-green-600">{t('settings.mfaSaved')}</p>}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.mfaSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
