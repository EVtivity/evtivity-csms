// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface ForceChangePasswordResponse {
  token: string;
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    language: string;
    timezone: string;
    themePreference: 'light' | 'dark';
  };
  role: { id: string; name: string } | null;
}

export function SetPassword(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const completeMfaLogin = useAuth((s) => s.completeMfaLogin);

  const email = (location.state as { email?: string } | null)?.email;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { companyName, companyLogo } = useAuthBranding();

  if (email == null) {
    return <Navigate to="/login" replace />;
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (currentPassword === '') errors.currentPassword = t('validation.required');
    if (newPassword.length < 12) errors.newPassword = t('validation.minLength', { min: 12 });
    if (confirmPassword !== newPassword) errors.confirmPassword = t('auth.passwordsMustMatch');
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
      const data = await api.post<ForceChangePasswordResponse>('/v1/auth/force-change-password', {
        email,
        currentPassword,
        newPassword,
      });
      setSuccess(true);
      await completeMfaLogin(data.user, data.role?.name ?? null);
      void navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; code?: string } | null;
        if (body?.code === 'INVALID_CREDENTIALS') {
          setError(t('auth.invalidCredentials'));
        } else if (body?.code === 'RESET_NOT_REQUIRED') {
          setError(t('auth.mustSetPassword'));
          setTimeout(() => {
            void navigate('/login');
          }, 2000);
        } else if (body?.code === 'VALIDATION_ERROR' && body.error) {
          setError(body.error);
        } else {
          setError(body?.error ?? t('errors.unknown'));
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
          <h2 className="text-2xl font-semibold">{t('auth.setPasswordTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('auth.setPasswordSubtitle')}</p>
        </CardHeader>
        <CardContent>
          {success ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('auth.setPasswordSuccess')}
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                void handleSubmit(e);
              }}
              noValidate
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label>{t('auth.emailLabel')}</Label>
                <p className="text-sm text-muted-foreground">{email}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="currentPassword">{t('auth.currentPassword')}</Label>
                <PasswordInput
                  id="currentPassword"
                  value={currentPassword}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors.currentPassword ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && validationErrors.currentPassword && (
                  <p className="text-sm text-destructive">{validationErrors.currentPassword}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">{t('auth.newPassword')}</Label>
                <PasswordInput
                  id="newPassword"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors.newPassword ? 'border-destructive' : ''
                  }
                />
                <p className="text-xs text-muted-foreground">{t('auth.passwordRequirements')}</p>
                {hasSubmitted && validationErrors.newPassword && (
                  <p className="text-sm text-destructive">{validationErrors.newPassword}</p>
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
              {error != null && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t('auth.settingPassword') : t('auth.setPasswordButton')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} />
    </div>
  );
}
