// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Mail, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/lib/auth';
import { api, ApiError, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

// The API allows one verification email a minute (and five a day) per driver.
const RESEND_COOLDOWN_SECONDS = 60;

function retryAfterSeconds(err: unknown): number | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as { retryAfterSeconds?: unknown } | null;
  const value = body?.retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

export function VerifyEmail(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const driver = useAuth((s) => s.driver);

  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [verifyError, setVerifyError] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  // Kept as the error, translated at render.
  const [resendError, setResendError] = useState<unknown>(null);

  // Token verification mode
  const verifyToken = useCallback(async () => {
    if (token == null) return;
    setStatus('loading');
    try {
      await api.post('/v1/portal/auth/verify-email', { token });
      setStatus('success');
      setTimeout(() => {
        void navigate('/', { replace: true });
      }, 2000);
    } catch (err) {
      // errors.INVALID_TOKEN names a reset link, so an invalid verification link keeps its own text.
      setVerifyError(
        getApiErrorCode(err) === 'INVALID_TOKEN'
          ? t('auth.verifyEmailFailed')
          : getErrorMessage(err, t, 'auth.verifyEmailFailed'),
      );
      setStatus('error');
    }
  }, [token, navigate, t]);

  useEffect(() => {
    void verifyToken();
  }, [verifyToken]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => {
      setResendCooldown((c) => c - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [resendCooldown]);

  async function handleResend(): Promise<void> {
    setResendLoading(true);
    setResendSuccess(false);
    setResendError(null);
    try {
      await api.post('/v1/portal/auth/resend-verification', {});
      setResendSuccess(true);
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      const code = getApiErrorCode(err);
      if (code === 'ALREADY_VERIFIED') {
        void navigate('/', { replace: true });
        return;
      }
      setResendError(err);
      if (code === 'VERIFICATION_RESEND_LIMITED' || code === 'RATE_LIMITED') {
        setResendCooldown(retryAfterSeconds(err) ?? RESEND_COOLDOWN_SECONDS);
      }
    } finally {
      setResendLoading(false);
    }
  }

  // If driver is already verified, redirect home
  useEffect(() => {
    if (driver?.emailVerified && token == null) {
      void navigate('/', { replace: true });
    }
  }, [driver, token, navigate]);

  // Token verification mode
  if (token != null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <h2 className="text-2xl font-semibold">{t('auth.verifyEmailTitle')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {status === 'loading' && (
              <>
                <Spinner className="h-8 w-8" />
                <p className="text-sm text-muted-foreground">{t('auth.verifyEmailChecking')}</p>
              </>
            )}
            {status === 'success' && (
              <>
                <CheckCircle className="h-8 w-8 text-success" />
                <p className="text-sm text-success">{t('auth.verifyEmailSuccess')}</p>
              </>
            )}
            {status === 'error' && (
              <>
                <AlertCircle className="h-8 w-8 text-destructive" />
                <p className="text-sm text-destructive">{verifyError}</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check your email mode. Rendered inside the app Layout, whose <main> is a flex column between
  // the header and the bottom nav: flex-1 fills it, so the card centers in the visible area
  // (min-h-screen here overflowed <main> and pushed the card below the middle).
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center"
      data-testid="verify-email-pending"
    >
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('auth.verifyEmailTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('auth.verifyEmailSubtitle', { email: driver?.email ?? '' })}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <Mail className="h-12 w-12 text-muted-foreground" />
          {resendSuccess && (
            <p className="text-sm text-success">{t('auth.resendVerificationSuccess')}</p>
          )}
          {resendError != null && (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(resendError, t)}
            </p>
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={resendLoading || resendCooldown > 0}
            onClick={() => {
              void handleResend();
            }}
          >
            {resendLoading
              ? t('auth.resendingVerification')
              : resendCooldown > 0 && resendCooldown <= RESEND_COOLDOWN_SECONDS
                ? t('auth.resendVerificationCooldown', { seconds: resendCooldown })
                : t('auth.resendVerification')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
