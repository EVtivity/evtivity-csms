// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { useAuth } from '@/lib/auth';

export function Register(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const register = useAuth((s) => s.register);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { companyName, companyLogo, branding } = useAuthBranding();

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (firstName.trim() === '') errors['firstName'] = t('validation.required');
    if (lastName.trim() === '') errors['lastName'] = t('validation.required');
    if (email.trim() === '') errors['email'] = t('validation.required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors['email'] = t('validation.email');
    if (password === '') errors['password'] = t('validation.required');
    else if (password.length < 12) errors['password'] = t('validation.minLength', { min: 12 });
    return errors;
  }

  const validationErrors = getValidationErrors();
  const hasErrors = Object.keys(validationErrors).length > 0;

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmitted(true);
    if (hasErrors) return;
    setError('');
    setLoading(true);
    try {
      await register({
        firstName,
        lastName,
        email,
        password,
        ...(phone !== '' ? { phone } : {}),
      });
      void navigate('/verify-email');
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('auth.registrationFailed'));
      } else {
        setError(t('auth.registrationFailed'));
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
          <h2 className="text-2xl font-semibold">{t('auth.createAccount')}</h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
            {error !== '' && <p className="text-sm text-destructive">{error}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor="firstName" className="text-sm font-medium">
                  {t('auth.firstName')}
                </label>
                <Input
                  id="firstName"
                  autoComplete="off"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors['firstName'] ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && validationErrors['firstName'] && (
                  <p className="text-xs text-destructive">{validationErrors['firstName']}</p>
                )}
              </div>
              <div className="space-y-2">
                <label htmlFor="lastName" className="text-sm font-medium">
                  {t('auth.lastName')}
                </label>
                <Input
                  id="lastName"
                  autoComplete="off"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors['lastName'] ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && validationErrors['lastName'] && (
                  <p className="text-xs text-destructive">{validationErrors['lastName']}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                {t('auth.email')}
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmitted && validationErrors['email'] ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors['email'] && (
                <p className="text-xs text-destructive">{validationErrors['email']}</p>
              )}
            </div>
            <div className="space-y-2">
              <label htmlFor="phone" className="text-sm font-medium">
                {t('auth.phoneOptional')}
              </label>
              <Input
                id="phone"
                type="tel"
                autoComplete="off"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                {t('auth.password')}
              </label>
              <PasswordInput
                id="password"
                autoComplete="off"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                className={hasSubmitted && validationErrors['password'] ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors['password'] && (
                <p className="text-xs text-destructive">{validationErrors['password']}</p>
              )}
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={loading}>
              {loading ? t('auth.creatingAccount') : t('auth.createAccount')}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.haveAccount')}{' '}
            <Link to="/login" className="text-primary hover:underline">
              {t('auth.signIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
