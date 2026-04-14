// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Theme } from '@/lib/theme';

interface PortalMfaVerifyResponse {
  driver: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    language: string;
    timezone: string;
    themePreference: Theme;
    distanceUnit: 'miles' | 'km';
    isActive: boolean;
    emailVerified: boolean;
    createdAt: string;
  };
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
      const data = await api.post<PortalMfaVerifyResponse>('/v1/portal/auth/mfa/verify', {
        mfaToken: mfaPending.mfaToken,
        code,
        challengeId,
      });
      await completeMfaLogin(data.driver);
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
      const data = await api.post<{ challengeId: string }>('/v1/portal/auth/mfa/resend', {
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
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{t('auth.mfaTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('auth.mfaSubtitle', { method: methodLabel })}
          </p>
          {error != null && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              void handleVerify(e);
            }}
            className="space-y-4"
          >
            <Input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              placeholder="000000"
              maxLength={6}
              autoFocus
              className="text-center text-2xl tracking-widest"
            />
            <Button type="submit" className="w-full" disabled={loading || code.length < 6}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
