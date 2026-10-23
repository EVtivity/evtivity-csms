// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Toggle } from '@/components/ui/toggle';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useLoadedValues, useSavedBaseline } from '@/hooks/use-loaded-values';
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
  /** Without `settings.system:write` the switches are read-only and there is no Save. */
  canWrite?: boolean;
  loadFailed?: boolean;
  onRetry?: () => void;
}

interface MfaValues {
  emailEnabled: boolean;
  totpEnabled: boolean;
  smsEnabled: boolean;
  required: MfaRequiredMode;
  requiredRoles: string[];
  webauthnEnabled: boolean;
  passkeyLoginEnabled: boolean;
  requireDrivers: boolean;
}

/** The switches in effect; the server sends defaults for unset keys. */
function valuesFrom(mfa: SecurityMfaSwitches | undefined): MfaValues {
  return {
    emailEnabled: mfa?.emailEnabled === true,
    totpEnabled: mfa?.totpEnabled === true,
    smsEnabled: mfa?.smsEnabled === true,
    required: mfa?.required ?? 'off',
    requiredRoles: mfa?.requiredRoles ?? [],
    webauthnEnabled: mfa?.webauthnEnabled !== false,
    passkeyLoginEnabled: mfa?.passkeyLoginEnabled === true,
    requireDrivers: mfa?.requireDrivers === true,
  };
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  warning,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /** The description says why the switch is locked (a missing provider). */
  warning?: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="leading-6">
          {label}
        </Label>
        {description != null && (
          <p
            className={`text-xs ${warning === true ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {description}
          </p>
        )}
      </div>
      <Toggle
        id={id}
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

export function SecurityMfaSettings({
  settings,
  canWrite = true,
  loadFailed = false,
  onRetry,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const loaded = useMemo(() => valuesFrom(settings?.mfa), [settings]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [values, setValues] = useLoadedValues<MfaValues>(loaded, () => {
    setHasSubmitted(false);
  });
  const [baseline, markSaved] = useSavedBaseline(loaded);
  const hasUnsavedChanges = JSON.stringify(values) !== JSON.stringify(baseline);
  const {
    emailEnabled,
    totpEnabled,
    smsEnabled,
    required,
    requiredRoles,
    webauthnEnabled,
    passkeyLoginEnabled,
    requireDrivers,
  } = values;

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

  function markChanged(next: Partial<MfaValues>): void {
    setValues((prev) => ({ ...prev, ...next }));
    mutation.reset();
  }

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
    const saved = values;
    mutation.mutate(
      {
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
      },
      {
        onSuccess: () => {
          setHasSubmitted(false);
          markSaved(saved);
        },
      },
    );
  }

  function toggleRole(name: string, checked: boolean): void {
    markChanged({
      requiredRoles: checked
        ? [...requiredRoles.filter((r) => r !== name), name]
        : requiredRoles.filter((r) => r !== name),
    });
  }

  if (loadFailed && settings == null) {
    return (
      <Card data-testid="mfa-settings-load-error">
        <CardContent className="flex flex-col items-center gap-3 pt-6">
          <p className="text-center text-sm text-destructive">{t('common.loadError')}</p>
          {onRetry != null && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.mfa')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('settings.mfaDescription')}</p>
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
          <ToggleRow
            id="mfa-email"
            label={t('settings.mfaEmail')}
            {...(!smtpConfigured ? { description: t('settings.mfaEmailDisabledHint') } : {})}
            warning={!smtpConfigured}
            checked={emailEnabled}
            disabled={!canWrite || !smtpConfigured}
            onChange={(v) => {
              markChanged({ emailEnabled: v });
            }}
          />

          <ToggleRow
            id="mfa-totp"
            label={t('settings.mfaTotp')}
            checked={totpEnabled}
            disabled={!canWrite}
            onChange={(v) => {
              markChanged({ totpEnabled: v });
            }}
          />

          <ToggleRow
            id="mfa-sms"
            label={t('settings.mfaSms')}
            {...(!twilioConfigured ? { description: t('settings.mfaSmsDisabledHint') } : {})}
            warning={!twilioConfigured}
            checked={smsEnabled}
            disabled={!canWrite || !twilioConfigured}
            onChange={(v) => {
              markChanged({ smsEnabled: v });
            }}
          />

          <ToggleRow
            id="mfa-webauthn"
            label={t('settings.mfaWebauthn')}
            description={t('settings.mfaWebauthnDescription')}
            checked={webauthnEnabled}
            disabled={!canWrite}
            onChange={(v) => {
              markChanged({ webauthnEnabled: v });
            }}
          />

          <ToggleRow
            id="mfa-passkey-login"
            label={t('settings.mfaPasskeyLogin')}
            description={
              webauthnEnabled
                ? t('settings.mfaPasskeyLoginDescription')
                : t('settings.mfaPasskeyLoginDisabledHint')
            }
            warning={!webauthnEnabled}
            checked={webauthnEnabled && passkeyLoginEnabled}
            disabled={!canWrite || !webauthnEnabled}
            onChange={(v) => {
              markChanged({ passkeyLoginEnabled: v });
            }}
          />

          <div className="space-y-2 rounded-lg border p-4">
            <Label htmlFor="mfa-required-select" className="leading-6">
              {t('settings.mfaRequired')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('settings.mfaRequiredDescription')}</p>
            <Select
              id="mfa-required-select"
              value={required}
              disabled={!canWrite}
              onChange={(e) => {
                markChanged({ required: e.target.value as MfaRequiredMode });
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
                  <div key={name} className="flex items-center gap-2">
                    <Checkbox
                      id={`mfa-role-${name}`}
                      checked={requiredRoles.includes(name)}
                      disabled={!canWrite}
                      onChange={(e) => {
                        toggleRole(name, e.target.checked);
                      }}
                    />
                    <Label htmlFor={`mfa-role-${name}`} className="font-normal capitalize">
                      {name}
                    </Label>
                  </div>
                ))}
                {hasSubmitted && validationErrors['requiredRoles'] != null && (
                  <p className="text-sm text-destructive">{validationErrors['requiredRoles']}</p>
                )}
              </fieldset>
            )}
          </div>

          <div className="space-y-2">
            <ToggleRow
              id="mfa-require-drivers"
              label={t('settings.mfaRequireDrivers')}
              description={t('settings.mfaRequireDriversDescription')}
              checked={requireDrivers}
              disabled={!canWrite}
              onChange={(v) => {
                markChanged({ requireDrivers: v });
              }}
            />
            {hasSubmitted && validationErrors['requireDrivers'] != null && (
              <p className="text-sm text-destructive">{validationErrors['requireDrivers']}</p>
            )}
          </div>

          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.mfaSaveFailed')}
            </p>
          )}
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {mutation.isSuccess && !hasUnsavedChanges && (
                <p className="text-sm text-success">{t('common.saved')}</p>
              )}
              {hasUnsavedChanges && (
                <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
              )}
              <SaveButton
                isPending={mutation.isPending}
                disabled={mutation.isPending || settings == null || !hasUnsavedChanges}
              />
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
