// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { LiveStatus } from '@/components/LiveStatus';
import { usePrefetchedOptions } from '@/hooks/use-prefetched-options';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { rateLimitedMessage } from '@/lib/error-message';
import {
  normalizeRecoveryCode,
  offersPasskey,
  offersPrimaryMethod,
  offersRecoveryCode,
  RECOVERY_CODE_LENGTH,
} from '@/lib/mfa-pending';
import {
  isMfaEnrollmentReply,
  mfaEnrollmentFromReply,
  type MfaEnrollmentReply,
} from '@/lib/mfa-enrollment';
import { passkeyErrorText, webauthnSupported } from '@/lib/webauthn';
import type { Theme } from '@/lib/theme';
import type { PriceDisplay } from '@evtivity/lib/price-display';

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
    priceDisplay: PriceDisplay | null;
    isActive: boolean;
    emailVerified: boolean;
    createdAt: string;
  };
  recoveryCodesRemaining?: number;
}

/** At or below this count the sign-in warns that recovery codes run out. */
const FEW_RECOVERY_CODES = 2;

type ChallengeMode = 'code' | 'recovery' | 'passkey';

export function MfaChallenge(): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const mfaPending = useAuth((s) => s.mfaPending);
  const completeMfaLogin = useAuth((s) => s.completeMfaLogin);
  const clearMfaPending = useAuth((s) => s.clearMfaPending);
  const setMfaEnrollment = useAuth((s) => s.setMfaEnrollment);

  const recoveryOffered = mfaPending != null && offersRecoveryCode(mfaPending);
  const primaryOffered = mfaPending == null || offersPrimaryMethod(mfaPending);
  // A passkey needs a secure page and a browser with WebAuthn.
  const passkeyOffered = mfaPending != null && offersPasskey(mfaPending) && webauthnSupported();

  const [mode, setMode] = useState<ChallengeMode>(
    primaryOffered ? 'code' : passkeyOffered ? 'passkey' : recoveryOffered ? 'recovery' : 'code',
  );
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [challengeId, setChallengeId] = useState(mfaPending?.challengeId);
  const passkeyPrompt = usePrefetchedOptions(
    () =>
      api.post<PublicKeyCredentialRequestOptionsJSON>('/v1/portal/auth/webauthn/options', {
        mfaToken: mfaPending?.mfaToken,
      }),
    passkeyOffered && !loading,
  );

  const recovery = mode === 'recovery';
  const passkey = mode === 'passkey';
  const normalizedRecoveryCode = normalizeRecoveryCode(recoveryCode);
  const canSubmit = passkey
    ? true
    : recovery
      ? normalizedRecoveryCode.length === RECOVERY_CODE_LENGTH
      : code.length >= 6;

  async function finish(data: PortalMfaVerifyResponse | MfaEnrollmentReply): Promise<void> {
    // The factor used was switched off and was the only one: no session, set up another.
    if (isMfaEnrollmentReply(data)) {
      setMfaEnrollment(mfaEnrollmentFromReply(data));
      return;
    }
    await completeMfaLogin(data.driver);
    if (data.recoveryCodesRemaining != null) {
      const remaining = data.recoveryCodesRemaining;
      toast({
        variant: remaining <= FEW_RECOVERY_CODES ? 'warning' : 'info',
        title: t('auth.recoveryCodesLeft', { count: remaining }),
        ...(remaining <= FEW_RECOVERY_CODES ? { description: t('auth.recoveryCodesLowHint') } : {}),
      });
    }
  }

  async function verifyPasskey(): Promise<void> {
    if (mfaPending == null) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      // Prefetched options start the prompt inside the click (Safari needs that).
      const optionsJSON = passkeyPrompt.take() ?? (await passkeyPrompt.load());
      const credential = await startAuthentication({ optionsJSON });
      const data = await api.post<PortalMfaVerifyResponse | MfaEnrollmentReply>(
        '/v1/portal/auth/webauthn/verify',
        {
          mfaToken: mfaPending.mfaToken,
          credential,
        },
      );
      await finish(data);
    } catch (err) {
      const text = passkeyErrorText(err, t, 'auth.passkeyFailed');
      if (text.quiet) setNotice(text.message);
      else setError(text.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (mfaPending == null) return;
    if (passkey) {
      await verifyPasskey();
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const data = await api.post<PortalMfaVerifyResponse | MfaEnrollmentReply>(
        '/v1/portal/auth/mfa/verify',
        recovery
          ? { mfaToken: mfaPending.mfaToken, recoveryCode: normalizedRecoveryCode }
          : { mfaToken: mfaPending.mfaToken, code, challengeId },
      );
      await finish(data);
    } catch (err) {
      setError(
        rateLimitedMessage(err, t) ??
          (recovery ? t('auth.recoveryCodeInvalid') : t('auth.mfaInvalidCode')),
      );
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
    } catch (err) {
      setError(rateLimitedMessage(err, t) ?? t('auth.mfaResendFailed'));
    } finally {
      setResending(false);
    }
  }

  function switchMode(next: ChallengeMode): void {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  const methodLabel =
    mfaPending?.mfaMethod === 'totp'
      ? t('auth.mfaMethodTotp')
      : mfaPending?.mfaMethod === 'sms'
        ? t('auth.mfaMethodSms')
        : t('auth.mfaMethodEmail');

  const canResend = mode === 'code' && mfaPending?.mfaMethod !== 'totp';

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{t('auth.mfaTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {passkey
              ? t('auth.passkeySubtitle')
              : recovery
                ? t('auth.recoveryCodeSubtitle')
                : t('auth.mfaSubtitle', { method: methodLabel })}
          </p>
          {recovery && mfaPending?.mfaMethodDisabled === true && (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('auth.mfaMethodSwitchedOff', { method: methodLabel })}
            </p>
          )}
          {error != null && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <LiveStatus message={notice} className="mt-2" />
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              void handleVerify(e);
            }}
            noValidate
            className="space-y-4"
          >
            {passkey ? null : recovery ? (
              <Input
                id="mfaRecoveryCode"
                aria-label={t('auth.recoveryCodeLabel')}
                value={recoveryCode}
                onChange={(e) => {
                  setRecoveryCode(e.target.value);
                }}
                placeholder="xxxxx-xxxxx"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                className="text-center text-lg tracking-widest"
              />
            ) : (
              <Input
                id="mfaCode"
                aria-label={t('auth.mfaCodeLabel')}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                }}
                placeholder="000000"
                maxLength={6}
                autoFocus
                className="text-center text-2xl tracking-widest"
              />
            )}
            <Button type="submit" className="w-full" disabled={loading || !canSubmit}>
              {loading && <Spinner className="mr-2 h-4 w-4" />}
              {passkey ? t('auth.usePasskey') : t('auth.mfaVerify')}
            </Button>
            <div className="flex flex-col items-center gap-1">
              {primaryOffered && mode !== 'code' && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    switchMode('code');
                  }}
                >
                  {t('auth.useVerificationCode')}
                </Button>
              )}
              {passkeyOffered && !passkey && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    switchMode('passkey');
                    // The prompt opens in this click: a second click would be one too many.
                    void verifyPasskey();
                  }}
                >
                  {t('auth.usePasskey')}
                </Button>
              )}
              {recoveryOffered && !recovery && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    switchMode('recovery');
                  }}
                >
                  {t('auth.useRecoveryCode')}
                </Button>
              )}
            </div>
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
