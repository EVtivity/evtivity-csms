// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { api, getApiErrorCode } from '@/lib/api';
import { executeRecaptcha } from '@/lib/recaptcha';
import { passwordRulesMessage } from '@/lib/password-rules';
import { PasswordRequirements } from '@/components/PasswordRequirements';

interface SecurityPublic {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
}

export function Register(): React.JSX.Element {
  const { t, i18n } = useTranslation();
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
  // The API refused the password (WEAK_PASSWORD). Translated at render, cleared on edit.
  const [serverWeakPassword, setServerWeakPassword] = useState(false);

  const { companyName, companyLogo, branding } = useAuthBranding();

  const { data: securityPublic } = useQuery({
    queryKey: ['security-public'],
    queryFn: () => api.get<SecurityPublic>('/v1/security/public'),
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (firstName.trim() === '') errors['firstName'] = t('validation.required');
    if (lastName.trim() === '') errors['lastName'] = t('validation.required');
    if (email.trim() === '') errors['email'] = t('validation.required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors['email'] = t('validation.email');
    if (password === '') errors['password'] = t('validation.required');
    else {
      const rulesError = passwordRulesMessage(password, t, i18n.language);
      if (rulesError != null) errors['password'] = rulesError;
      else if (serverWeakPassword) errors['password'] = t('errors.WEAK_PASSWORD');
    }
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
      let recaptchaToken: string | undefined;
      if (securityPublic?.recaptchaEnabled && securityPublic.recaptchaSiteKey !== '') {
        recaptchaToken = await executeRecaptcha(securityPublic.recaptchaSiteKey, 'register');
      }
      await register({
        firstName,
        lastName,
        email,
        password,
        ...(phone !== '' ? { phone } : {}),
        ...(recaptchaToken != null ? { recaptchaToken } : {}),
      });
      void navigate('/verify-email');
    } catch (err: unknown) {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerWeakPassword(true);
      else setError(getErrorMessage(err, t, 'auth.registrationFailed'));
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
                <label htmlFor="firstName" className="block text-sm font-medium leading-6">
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
                <label htmlFor="lastName" className="block text-sm font-medium leading-6">
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
              <label htmlFor="email" className="block text-sm font-medium leading-6">
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
              <label htmlFor="phone" className="block text-sm font-medium leading-6">
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
              <label htmlFor="password" className="block text-sm font-medium leading-6">
                {t('auth.password')}
              </label>
              <PasswordInput
                id="password"
                autoComplete="off"
                value={password}
                aria-describedby="password-requirements"
                onChange={(e) => {
                  setPassword(e.target.value);
                  setServerWeakPassword(false);
                }}
                className={hasSubmitted && validationErrors['password'] ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors['password'] && (
                <p className="text-xs text-destructive">{validationErrors['password']}</p>
              )}
              <PasswordRequirements
                id="password-requirements"
                password={password}
                showUnmet={hasSubmitted}
              />
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
