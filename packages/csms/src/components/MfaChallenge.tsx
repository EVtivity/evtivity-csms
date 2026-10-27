// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CardContent, CardHeader } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { AuthLayout } from '@/components/AuthLayout';
import { LiveStatus } from '@/components/LiveStatus';
import { usePrefetchedOptions } from '@/hooks/use-prefetched-options';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { rateLimitedMessage } from '@/lib/error-message';
import {
  isMfaEnrollmentReply,
  mfaEnrollmentFromReply,
  type MfaEnrollmentReply,
} from '@/lib/mfa-enrollment';
import {
  normalizeRecoveryCode,
  offersPasskey,
  offersPrimaryMethod,
  offersRecoveryCode,
  RECOVERY_CODE_LENGTH,
} from '@/lib/mfa-pending';
import { passkeyErrorText, webauthnUnavailableReason } from '@/lib/webauthn';
import { passkeyUnavailableKey, signInPasskeyContext } from '@/lib/passkey-unavailable';

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
  const setMfaEnrollment = useAuth((s) => s.setMfaEnrollment);
  const clearMfaPending = useAuth((s) => s.clearMfaPending);

  const recoveryOffered = mfaPending != null && offersRecoveryCode(mfaPending);
  const primaryOffered = mfaPending == null || offersPrimaryMethod(mfaPending);
  // A passkey needs a secure page and a browser with WebAuthn. When the account has one and
  // this page cannot use it, the challenge says why instead of hiding it.
  const passkeyAccepted = mfaPending != null && offersPasskey(mfaPending);
  const passkeyUnavailable = passkeyAccepted ? webauthnUnavailableReason() : null;
  const passkeyOffered = passkeyAccepted && passkeyUnavailable == null;
  const unavailableKey =
    passkeyUnavailable == null
      ? null
      : passkeyUnavailableKey(
          passkeyUnavailable,
          signInPasskeyContext(primaryOffered, recoveryOffered),
        );
  // A passkey-only account on such a page: no input here can succeed.
  const noFactorHere = passkeyUnavailable != null && !primaryOffered && !recoveryOffered;

  const [mode, setMode] = useState<ChallengeMode>(
    primaryOffered ? 'code' : passkeyOffered ? 'passkey' : recoveryOffered ? 'recovery' : 'code',
  );
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [resending, setResending] = useState(false);
  const [challengeId, setChallengeId] = useState(mfaPending?.challengeId);
  const passkeyPrompt = usePrefetchedOptions(
    () =>
      api.post<PublicKeyCredentialRequestOptionsJSON>('/v1/auth/webauthn/options', {
        mfaToken: mfaPending?.mfaToken,
      }),
    passkeyOffered && !loading,
  );

  const recovery = mode === 'recovery';
  const passkey = mode === 'passkey';
  const normalizedRecoveryCode = normalizeRecoveryCode(recoveryCode);
  // The button stays enabled: a click on an incomplete code shows why and sends nothing.
  const inputError = passkey
    ? null
    : recovery
      ? normalizedRecoveryCode.length === RECOVERY_CODE_LENGTH
        ? null
        : t('auth.recoveryCodeIncomplete')
      : /^\d{6}$/.test(code)
        ? null
        : t('profile.mfaEnterCode');
  const showInputError = hasSubmitted && inputError != null;

  async function finish(data: MfaVerifyResponse | MfaEnrollmentReply): Promise<void> {
    // A switched-off factor that was the only one: set up another one before the session.
    if (isMfaEnrollmentReply(data)) {
      setMfaEnrollment(mfaEnrollmentFromReply(data));
      return;
    }
    await completeMfaLogin(data.user, data.role?.name ?? null);
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
      const data = await api.post<MfaVerifyResponse | MfaEnrollmentReply>(
        '/v1/auth/webauthn/verify',
        { mfaToken: mfaPending.mfaToken, credential },
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
    setHasSubmitted(true);
    if (inputError != null) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const data = await api.post<MfaVerifyResponse | MfaEnrollmentReply>(
        '/v1/auth/mfa/verify',
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
      const data = await api.post<{ challengeId: string }>('/v1/auth/mfa/resend', {
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
    setHasSubmitted(false);
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
    <AuthLayout>
      <CardHeader className="text-center">
        <h2 className="text-2xl font-semibold">{t('auth.mfaTitle')}</h2>
        {!noFactorHere && (
          <p className="text-sm text-muted-foreground">
            {passkey
              ? t('auth.passkeySubtitle')
              : recovery
                ? t('auth.recoveryCodeSubtitle')
                : t('auth.mfaSubtitle', { method: methodLabel })}
          </p>
        )}
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
      <CardContent className="space-y-4">
        {unavailableKey != null && (
          <Alert variant="info" data-testid="passkey-unavailable">
            <Info className="h-4 w-4" />
            <AlertDescription>{t(unavailableKey)}</AlertDescription>
          </Alert>
        )}
        {noFactorHere ? (
          <Button type="button" variant="outline" className="w-full" onClick={clearMfaPending}>
            {t('auth.backToLogin')}
          </Button>
        ) : (
          <form
            onSubmit={(e) => {
              void handleVerify(e);
            }}
            noValidate
            className="space-y-4"
          >
            {passkey ? null : recovery ? (
              <div className="space-y-2">
                <Label htmlFor="mfaRecoveryCode" className="sr-only leading-6">
                  {t('auth.recoveryCodeLabel')}
                </Label>
                <Input
                  id="mfaRecoveryCode"
                  value={recoveryCode}
                  onChange={(e) => {
                    setRecoveryCode(e.target.value);
                  }}
                  placeholder="xxxxx-xxxxx"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={showInputError}
                  aria-describedby={showInputError ? 'mfaInputError' : undefined}
                  className={`text-center text-lg tracking-widest${showInputError ? ' border-destructive' : ''}`}
                />
                {showInputError && (
                  <p id="mfaInputError" className="text-sm text-destructive">
                    {inputError}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="mfaCode" className="sr-only leading-6">
                  {t('auth.mfaCodeLabel')}
                </Label>
                <Input
                  id="mfaCode"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                  }}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  aria-invalid={showInputError}
                  aria-describedby={showInputError ? 'mfaInputError' : undefined}
                  className={`text-center text-2xl tracking-widest${showInputError ? ' border-destructive' : ''}`}
                />
                {showInputError && (
                  <p id="mfaInputError" className="text-sm text-destructive">
                    {inputError}
                  </p>
                )}
              </div>
            )}
            <Button type="submit" className="relative w-full" disabled={loading}>
              {loading && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Spinner className="h-4 w-4" />
                </span>
              )}
              <span className={loading ? 'invisible' : ''}>
                {passkey ? t('auth.usePasskey') : t('auth.mfaVerify')}
              </span>
            </Button>
            <div className="flex flex-col items-center gap-2">
              {primaryOffered && mode !== 'code' && (
                <Button
                  type="button"
                  variant="link"
                  size="inline"
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
                  size="inline"
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
                  size="inline"
                  onClick={() => {
                    switchMode('recovery');
                  }}
                >
                  {t('auth.useRecoveryCode')}
                </Button>
              )}
            </div>
            {canResend && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="link"
                  size="inline"
                  onClick={() => void handleResend()}
                  disabled={resending}
                >
                  {resending ? t('auth.mfaResending') : t('auth.mfaResend')}
                </Button>
              </div>
            )}
            <div className="flex justify-center">
              <Button type="button" variant="link" size="inline" onClick={clearMfaPending}>
                {t('auth.backToLogin')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </AuthLayout>
  );
}
