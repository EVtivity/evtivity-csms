// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { SaveButton } from '@/components/save-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Props {
  settings: Record<string, unknown> | undefined;
}

export function SecurityRecaptchaSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [enabled, setEnabled] = useState(false);
  const [siteKey, setSiteKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [threshold, setThreshold] = useState('0.5');

  useEffect(() => {
    if (settings == null) return;
    setEnabled(settings['security.recaptcha.enabled'] === true);
    setSiteKey(
      typeof settings['security.recaptcha.siteKey'] === 'string'
        ? settings['security.recaptcha.siteKey']
        : '',
    );
    const th = settings['security.recaptcha.threshold'];
    if (typeof th === 'number') setThreshold(String(th));
  }, [settings]);

  // The stored state, not the unsaved toggle: the warning says what protects sign-up now.
  const savedEnabled = settings?.['security.recaptcha.enabled'] === true;

  const hasSavedSecret =
    typeof settings?.['security.recaptcha.secretKeyEnc'] === 'string' &&
    settings['security.recaptcha.secretKeyEnc'] !== '';

  const mutation = useMutation({
    mutationFn: (vals: {
      enabled: boolean;
      siteKey: string;
      secretKey?: string;
      threshold: number;
    }) => api.put<{ success: boolean }>('/v1/security/recaptcha', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['security-settings'] });
    },
  });

  function handleSave(): void {
    const th = parseFloat(threshold);
    mutation.mutate({
      enabled,
      siteKey,
      ...(secretKey !== '' ? { secretKey } : {}),
      threshold: Number.isNaN(th) ? 0.5 : Math.min(1, Math.max(0, th)),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.recaptcha')}</CardTitle>
      </CardHeader>
      <CardContent>
        {settings != null && !savedEnabled && (
          <Alert variant="warning" className="mb-4" data-testid="recaptcha-off-warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{t('settings.recaptchaOffWarning')}</AlertDescription>
          </Alert>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          noValidate
          className="space-y-4"
        >
          <p className="text-sm text-muted-foreground">{t('settings.recaptchaDescription')}</p>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label className="leading-6">{t('settings.recaptchaEnabled')}</Label>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => {
                setEnabled((v) => !v);
              }}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recaptcha-site-key" className="leading-6">
              {t('settings.recaptchaSiteKey')}
            </Label>
            <Input
              id="recaptcha-site-key"
              value={siteKey}
              onChange={(e) => {
                setSiteKey(e.target.value);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="recaptcha-secret-key" className="leading-6">
              {t('settings.recaptchaSecretKey')}
            </Label>
            <PasswordInput
              id="recaptcha-secret-key"
              value={secretKey}
              onChange={(e) => {
                setSecretKey(e.target.value);
              }}
              placeholder={hasSavedSecret ? '••••••••' : undefined}
            />
            <p className="text-xs text-muted-foreground">{t('settings.recaptchaSecretHint')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recaptcha-threshold" className="leading-6">
              {t('settings.recaptchaThreshold')}
            </Label>
            <DecimalInput id="recaptcha-threshold" value={threshold} onChange={setThreshold} />
            <p className="text-xs text-muted-foreground">{t('settings.recaptchaThresholdHint')}</p>
          </div>

          <SaveButton isPending={mutation.isPending} />

          {mutation.isSuccess && (
            <p className="text-sm text-green-600">{t('settings.recaptchaSaved')}</p>
          )}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.recaptchaSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
