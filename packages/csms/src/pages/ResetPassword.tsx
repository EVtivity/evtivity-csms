// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api, ApiError } from '@/lib/api';
import { passwordRulesMessage } from '@/lib/password-rules';
import { usePasswordPolicy, useWeakPasswordReply } from '@/hooks/use-password-policy';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import { rateLimitedMessage } from '@/lib/error-message';
import type { PasswordRule } from '@evtivity/lib/password-policy';

export function ResetPassword(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const passwordPolicy = usePasswordPolicy();
  const weakPasswordReply = useWeakPasswordReply();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // The rules a WEAK_PASSWORD reply named. Translated at render, cleared on edit.
  const [serverMissing, setServerMissing] = useState<PasswordRule[] | null>(null);

  const { companyName, companyLogo } = useAuthBranding();

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const rulesError = passwordRulesMessage(
      password,
      passwordPolicy,
      t,
      i18n.language,
      serverMissing,
    );
    if (rulesError != null) errors.password = rulesError;
    if (confirmPassword !== password) errors.confirmPassword = t('auth.passwordsMustMatch');
    return errors;
  }

  const validationErrors = getValidationErrors();
  const hasErrors = Object.keys(validationErrors).length > 0;

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    setHasSubmitted(true);
    if (hasErrors) return;
    setError(null);
    setLoading(true);
    try {
      await api.post('/v1/auth/reset-password', { token, password });
      setSuccess(true);
    } catch (err) {
      const limited = rateLimitedMessage(err, t);
      if (limited != null) {
        setError(limited);
      } else if (err instanceof ApiError) {
        const body = err.body as { code?: string } | null;
        if (body?.code === 'INVALID_TOKEN') {
          setError(t('auth.invalidResetLink'));
        } else if (body?.code === 'WEAK_PASSWORD') {
          setServerMissing(weakPasswordReply(err) ?? []);
        } else {
          setError(t('errors.unknown'));
        }
      } else {
        setError(t('errors.unknown'));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('auth.resetPasswordTitle')}</h2>
          {!success && token != null && (
            <p className="text-sm text-muted-foreground">{t('auth.resetPasswordSubtitle')}</p>
          )}
        </CardHeader>
        <CardContent>
          {token == null ? (
            <div className="space-y-4">
              <p className="text-sm text-destructive">{t('auth.invalidResetLink')}</p>
              <p className="text-sm text-muted-foreground">{t('auth.contactAdminForInvite')}</p>
            </div>
          ) : success ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('auth.passwordResetSuccess')}</p>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-link hover:underline"
              >
                {t('auth.backToLogin')}
              </Link>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                void handleSubmit(e);
              }}
              noValidate
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="password" className="leading-6">
                  {t('auth.newPassword')}
                </Label>
                <PasswordInput
                  id="password"
                  value={password}
                  aria-invalid={hasSubmitted && validationErrors.password ? true : undefined}
                  aria-describedby={
                    hasSubmitted && validationErrors.password
                      ? 'password-error password-requirements'
                      : 'password-requirements'
                  }
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setServerMissing(null);
                  }}
                  className={hasSubmitted && validationErrors.password ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.password && (
                  <p id="password-error" className="text-sm text-destructive">
                    {validationErrors.password}
                  </p>
                )}
                <PasswordRequirements
                  policy={passwordPolicy}
                  serverMissing={serverMissing}
                  id="password-requirements"
                  password={password}
                  showUnmet={hasSubmitted}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="leading-6">
                  {t('auth.confirmPassword')}
                </Label>
                <PasswordInput
                  id="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors.confirmPassword ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && validationErrors.confirmPassword && (
                  <p className="text-sm text-destructive">{validationErrors.confirmPassword}</p>
                )}
              </div>
              {error != null && (
                <div className="space-y-2">
                  <p className="text-sm text-destructive">{error}</p>
                  {error === t('auth.invalidResetLink') && (
                    <p className="text-sm text-muted-foreground">
                      {t('auth.contactAdminForInvite')}
                    </p>
                  )}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t('auth.resettingPassword') : t('auth.resetPassword')}
              </Button>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-link hover:underline"
              >
                {t('auth.backToLogin')}
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} />
    </div>
  );
}
