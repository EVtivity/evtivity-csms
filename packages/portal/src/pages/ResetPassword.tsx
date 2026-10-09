// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api, ApiError } from '@/lib/api';
import { passwordRulesMessage } from '@/lib/password-rules';
import { executeRecaptcha } from '@/lib/recaptcha';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import { rateLimitedMessage } from '@/lib/error-message';

interface SecurityPublic {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
}

export function ResetPassword(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // The API refused the password (WEAK_PASSWORD). Translated at render, cleared on edit.
  const [serverWeakPassword, setServerWeakPassword] = useState(false);

  const { companyName, companyLogo, branding } = useAuthBranding();

  const { data: securityPublic } = useQuery({
    queryKey: ['security-public'],
    queryFn: () => api.get<SecurityPublic>('/v1/security/public'),
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const rulesError = passwordRulesMessage(password, t, i18n.language);
    if (rulesError != null) errors.password = rulesError;
    else if (serverWeakPassword) errors.password = t('errors.WEAK_PASSWORD');
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
      let recaptchaToken: string | undefined;
      if (securityPublic?.recaptchaEnabled && securityPublic.recaptchaSiteKey !== '') {
        recaptchaToken = await executeRecaptcha(securityPublic.recaptchaSiteKey, 'reset_password');
      }
      await api.post('/v1/portal/auth/reset-password', { token, password, recaptchaToken });
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
          setServerWeakPassword(true);
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
              <Link
                to="/forgot-password"
                className="block text-center text-sm font-medium text-primary hover:underline"
              >
                {t('auth.requestNewLink')}
              </Link>
            </div>
          ) : success ? (
            <div className="space-y-4">
              <p className="text-sm text-success">{t('auth.passwordResetSuccess')}</p>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-primary hover:underline"
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
                <label htmlFor="password" className="block text-sm font-medium leading-6">
                  {t('auth.newPassword')}
                </label>
                <PasswordInput
                  id="password"
                  value={password}
                  aria-describedby="password-requirements"
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setServerWeakPassword(false);
                  }}
                  className={hasSubmitted && validationErrors.password ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.password && (
                  <p className="text-sm text-destructive">{validationErrors.password}</p>
                )}
                <PasswordRequirements
                  id="password-requirements"
                  password={password}
                  showUnmet={hasSubmitted}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="confirmPassword" className="block text-sm font-medium leading-6">
                  {t('auth.confirmPassword')}
                </label>
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
                    <Link
                      to="/forgot-password"
                      className="block text-center text-sm font-medium text-primary hover:underline"
                    >
                      {t('auth.requestNewLink')}
                    </Link>
                  )}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t('auth.resettingPassword') : t('auth.resetPassword')}
              </Button>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-primary hover:underline"
              >
                {t('auth.backToLogin')}
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
