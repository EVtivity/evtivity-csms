// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

interface MfaVerifyResponse {
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

export function MfaChallenge(): React.JSX.Element {
  const { t } = useTranslation();
  const mfaPending = useAuth((s) => s.mfaPending);
  const completeMfaLogin = useAuth((s) => s.completeMfaLogin);
  const clearMfaPending = useAuth((s) => s.clearMfaPending);

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [challengeId, setChallengeId] = useState(mfaPending?.challengeId);

  async function handleVerify(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (mfaPending == null) return;
    setError(null);
    setLoading(true);
    try {
      const data = await api.post<MfaVerifyResponse>('/v1/auth/mfa/verify', {
        mfaToken: mfaPending.mfaToken,
        code,
        challengeId,
      });
      await completeMfaLogin(data.user, data.role?.name ?? null);
    } catch {
      setError(t('auth.mfaInvalidCode'));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend(): Promise<void> {
    if (mfaPending == null) return;
    setResending(true);
    try {
      const data = await api.post<{ challengeId: string }>('/v1/auth/mfa/resend', {
        mfaToken: mfaPending.mfaToken,
      });
      setChallengeId(data.challengeId);
      setError(null);
    } catch {
      setError(t('auth.mfaResendFailed'));
    } finally {
      setResending(false);
    }
  }

  const methodLabel =
    mfaPending?.mfaMethod === 'totp'
      ? t('auth.mfaMethodTotp')
      : mfaPending?.mfaMethod === 'sms'
        ? t('auth.mfaMethodSms')
        : t('auth.mfaMethodEmail');

  const canResend = mfaPending?.mfaMethod !== 'totp';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{t('auth.mfaTitle')}</CardTitle>
          <CardDescription>{t('auth.mfaSubtitle', { method: methodLabel })}</CardDescription>
          {error != null && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              void handleVerify(e);
            }}
            noValidate
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="mfaCode" className="sr-only">
                {t('auth.mfaCodeLabel')}
              </Label>
              <Input
                id="mfaCode"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                }}
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="text-center text-2xl tracking-widest"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || code.length < 6}>
              {loading && <Spinner className="h-4 w-4" />}
              {t('auth.mfaVerify')}
            </Button>
            <div className="flex items-center justify-between">
              {canResend && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleResend()}
                  disabled={resending}
                >
                  {resending ? t('auth.mfaResending') : t('auth.mfaResend')}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={clearMfaPending}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
