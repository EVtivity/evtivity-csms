// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api, ApiError } from '@/lib/api';

export function ForgotPassword(): React.JSX.Element {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { companyName, companyLogo, branding } = useAuthBranding();

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (email.trim() === '') {
      errors.email = t('validation.required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = t('validation.email');
    }
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
      await api.post('/v1/portal/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(t('errors.unknown'));
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
          <h2 className="text-2xl font-semibold">{t('auth.forgotPasswordTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('auth.forgotPasswordSubtitle')}</p>
          {sent && <p className="text-sm text-success">{t('auth.resetLinkSent')}</p>}
          {error != null && <p className="text-sm text-destructive">{error}</p>}
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            noValidate
            className="space-y-4"
          >
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium leading-none">
                {t('auth.email')}
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="off"
                value={email}
                disabled={sent}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmitted && validationErrors.email ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors.email && (
                <p className="text-sm text-destructive">{validationErrors.email}</p>
              )}
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={loading || sent}>
              {loading ? t('auth.sendingResetLink') : t('auth.sendResetLink')}
            </Button>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-primary hover:underline"
            >
              {t('auth.backToLogin')}
            </Link>
          </form>
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
