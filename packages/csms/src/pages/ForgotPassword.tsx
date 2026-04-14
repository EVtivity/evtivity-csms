// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

export function ForgotPassword(): React.JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const redirectMessage = (location.state as { message?: string } | null)?.message ?? null;
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { companyName, companyLogo } = useAuthBranding();

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
      await api.post('/v1/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(getErrorMessage(err, t));
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
          {redirectMessage != null && <p className="text-sm text-warning">{redirectMessage}</p>}
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
              <Label htmlFor="email">{t('auth.emailLabel')}</Label>
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
            <Button type="submit" className="w-full" disabled={loading || sent}>
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
      <AuthFooter companyName={companyName} />
    </div>
  );
}
