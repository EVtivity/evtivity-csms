// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { useAuth, MustResetPasswordError } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { executeRecaptcha } from '@/lib/recaptcha';
import { MfaChallenge } from '@/components/MfaChallenge';
import { API_BASE_URL } from '@/lib/config';

const DEV_AUTO_LOGIN = import.meta.env.VITE_CSMS_AUTO_LOGIN;

interface SecurityPublic {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
  mfaMethods: string[];
  ssoEnabled: boolean;
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
  const { companyName, companyLogo, portalUrl, themeColor } = useAuthBranding();

  // Handle SSO error query params
  useEffect(() => {
    const ssoError = searchParams.get('error');
    if (ssoError == null) return;
    const errorMap: Record<string, string> = {
      sso_no_email: t('auth.ssoNoEmail'),
      sso_account_disabled: t('auth.ssoAccountDisabled'),
      sso_user_not_found: t('auth.ssoUserNotFound'),
      sso_config_error: t('auth.ssoConfigError'),
    };
    const message = errorMap[ssoError];
    if (message != null) setError(message);
  }, [searchParams, t]);

  const { data: securityPublic } = useQuery({
    queryKey: ['security-public'],
    queryFn: () => api.get<SecurityPublic>('/v1/security/public'),
  });

  useEffect(() => {
    if (isAuthenticated) {
      void navigate('/');
    }
  }, [isAuthenticated, navigate]);

  const noAutoLogin =
    searchParams.get('noAutoLogin') === 'true' || sessionStorage.getItem('noAutoLogin') === 'true';

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
        await login(DEV_AUTO_LOGIN, 'admin123', recaptchaToken);
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
      if (err instanceof MustResetPasswordError) {
        void navigate('/set-password', { state: { email } });
        return;
      }
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
      {portalUrl != null && (
        <a
          href={portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed top-8 right-0 inline-flex items-center gap-2 rounded-l-full px-5 py-3 text-sm font-medium text-primary-foreground shadow-md transition-opacity hover:opacity-90"
          style={{ backgroundColor: themeColor }}
        >
          {companyName ?? 'EVtivity'} Charging Portal
        </a>
      )}
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
              <Label htmlFor="email">{t('auth.emailLabel')}</Label>
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
              <Label htmlFor="password">{t('auth.passwordLabel')}</Label>
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
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
            <div className="text-center">
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-primary hover:underline"
              >
                {t('auth.forgotPassword')}
              </Link>
            </div>
            {securityPublic?.ssoEnabled && (
              <>
                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t('auth.or')}</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    window.location.href = `${API_BASE_URL}/v1/auth/sso/login`;
                  }}
                >
                  {t('auth.signInWithSso')}
                </Button>
              </>
            )}
          </form>
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} recaptchaEnabled={securityPublic?.recaptchaEnabled} />
    </div>
  );
}
