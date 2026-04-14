// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api, ApiError } from '@/lib/api';

export function ResetPassword(): React.JSX.Element {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { companyName, companyLogo } = useAuthBranding();

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (password.length < 8) errors.password = t('validation.minLength', { min: 8 });
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
      if (err instanceof ApiError) {
        const body = err.body as { code?: string } | null;
        if (body?.code === 'INVALID_TOKEN') {
          setError(t('auth.invalidResetLink'));
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
                <Label htmlFor="password">{t('auth.newPassword')}</Label>
                <PasswordInput
                  id="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.password ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.password && (
                  <p className="text-sm text-destructive">{validationErrors.password}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t('auth.confirmPassword')}</Label>
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
                className="block text-center text-sm font-medium text-primary hover:underline"
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
