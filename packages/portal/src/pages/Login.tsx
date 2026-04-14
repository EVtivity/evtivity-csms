// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { executeRecaptcha } from '@/lib/recaptcha';
import { MfaChallenge } from '@/components/MfaChallenge';

const DEV_AUTO_LOGIN = import.meta.env.VITE_PORTAL_AUTO_LOGIN;

interface SecurityPublic {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
  mfaMethods: string[];
}

export function Login(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuth((s) => s.login);
  const mfaPending = useAuth((s) => s.mfaPending);
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const autoLoginAttempted = useRef(false);
  const [searchParams] = useSearchParams();
  const noAutoLogin =
    searchParams.get('noAutoLogin') === 'true' || sessionStorage.getItem('noAutoLogin') === 'true';

  const { companyName, companyLogo, branding } = useAuthBranding();

  const { data: securityPublic } = useQuery({
    queryKey: ['security-public'],
    queryFn: () => api.get<SecurityPublic>('/v1/security/public'),
  });

  useEffect(() => {
    if (isAuthenticated) {
      void navigate('/');
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('reason') === 'session_expired') {
      setError(t('auth.sessionExpired'));
      window.history.replaceState({}, '', '/login');
    }
  }, [t]);

  useEffect(() => {
    if (
      DEV_AUTO_LOGIN &&
      !noAutoLogin &&
      !isAuthenticated &&
      !autoLoginAttempted.current &&
      securityPublic !== undefined
    ) {
      autoLoginAttempted.current = true;
      void (async () => {
        let recaptchaToken: string | undefined;
        if (securityPublic.recaptchaEnabled && securityPublic.recaptchaSiteKey !== '') {
          recaptchaToken = await executeRecaptcha(securityPublic.recaptchaSiteKey, 'login');
        }
        await login(DEV_AUTO_LOGIN, 'driver123', recaptchaToken);
      })();
    }
  }, [isAuthenticated, login, securityPublic]);

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (email.trim() === '') errors.email = t('validation.required');
    if (password === '') errors.password = t('validation.required');
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
        recaptchaToken = await executeRecaptcha(securityPublic.recaptchaSiteKey, 'login');
      }
      await login(email, password, recaptchaToken);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { code?: string } | null;
        if (body?.code === 'RECAPTCHA_REQUIRED' || body?.code === 'RECAPTCHA_FAILED') {
          setError(t('auth.recaptchaFailed'));
        } else {
          setError(t('auth.invalidCredentials'));
        }
      } else {
        setError(t('auth.invalidCredentials'));
      }
    } finally {
      setLoading(false);
    }
  }

  if (mfaPending != null) {
    return <MfaChallenge />;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('auth.signIn')}</h2>
          {error != null && <p className="mt-2 text-sm text-destructive">{error}</p>}
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
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmitted && validationErrors.email ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors.email && (
                <p className="text-sm text-destructive">{validationErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium leading-none">
                {t('auth.password')}
              </label>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                autoComplete="current-password"
                className={hasSubmitted && validationErrors.password ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors.password && (
                <p className="text-sm text-destructive">{validationErrors.password}</p>
              )}
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={loading}>
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
            <div className="text-center">
              <Link to="/forgot-password" className="text-sm text-primary hover:underline">
                {t('auth.forgotPassword')}
              </Link>
            </div>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link to="/register" className="text-primary hover:underline">
              {t('auth.createOne')}
            </Link>
          </p>
        </CardContent>
      </Card>
      <AuthFooter
        companyName={companyName}
        branding={branding}
        recaptchaEnabled={securityPublic?.recaptchaEnabled}
      />
    </div>
  );
}
