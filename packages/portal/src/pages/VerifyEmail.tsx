// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';

export function VerifyEmail(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const driver = useAuth((s) => s.driver);

  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

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
    } catch {
      setStatus('error');
    }
  }, [token, navigate]);

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
    try {
      await api.post('/v1/portal/auth/resend-verification', {});
      setResendSuccess(true);
      setResendCooldown(60);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { code?: string } | null;
        if (body?.code === 'ALREADY_VERIFIED') {
          void navigate('/', { replace: true });
        }
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
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
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
                <p className="text-sm text-destructive">{t('auth.verifyEmailFailed')}</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check your email mode
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
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
              : resendCooldown > 0
                ? t('auth.resendVerificationCooldown', { seconds: resendCooldown })
                : t('auth.resendVerification')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
