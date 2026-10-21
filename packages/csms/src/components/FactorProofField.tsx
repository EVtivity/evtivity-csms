// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import {
  startAuthentication,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LiveStatus } from '@/components/LiveStatus';
import { useQuery } from '@tanstack/react-query';
import { usePrefetchedOptions } from '@/hooks/use-prefetched-options';
import { MFA_STATUS_KEY, type MfaStatus } from '@/components/profile/mfa-status';
import { startSsoSignIn } from '@/lib/sso-signin';
import { api, ApiError } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { passkeyErrorText, webauthnSupported } from '@/lib/webauthn';

/** A proof the API takes before it adds a factor, removes the last one or replaces the recovery codes. */
export type FactorProofKind = 'passkey' | 'totp' | 'code' | 'recovery_code' | 'password' | 'sso';

/** The `proof` body of the calls that take a fresh proof of the account. */
export interface FactorProof {
  kind: FactorProofKind;
  code?: string;
  challengeId?: number;
  credential?: AuthenticationResponseJSON;
  password?: string;
  recoveryCode?: string;
}

/**
 * A call that carried the proof failed: what the API answered (its error code,
 * or null when unknown). A new object each time, so the field resets once per failure.
 */
export interface ProofRejection {
  code: string | null;
}

/** The rejection of a failed call that carried the proof and checked nothing else that takes a code. */
export function proofRejection(err: unknown): ProofRejection {
  if (!(err instanceof ApiError)) return { code: null };
  const body = err.body as { code?: unknown } | null;
  return {
    code:
      body != null && typeof body === 'object' && typeof body.code === 'string' ? body.code : null,
  };
}

// The first one the account has is the default: a passkey needs no typing and sends nothing.
const PROOF_ORDER: readonly FactorProofKind[] = [
  'passkey',
  'totp',
  'code',
  'recovery_code',
  'password',
  'sso',
];

const KIND_LABELS: Record<FactorProofKind, string> = {
  passkey: 'factorProof.kindPasskey',
  totp: 'factorProof.kindTotp',
  code: 'factorProof.kindCodeEmail',
  recovery_code: 'factorProof.kindRecoveryCode',
  password: 'factorProof.kindPassword',
  sso: 'factorProof.kindSso',
};

/** An email or SMS code is valid for 5 minutes. */
const CODE_MAX_AGE_MS = 5 * 60_000;

/** The proof kinds this page can offer: a passkey only where the browser can use one. */
export function usableProofKinds(kinds: readonly string[]): FactorProofKind[] {
  const passkeys = webauthnSupported();
  return PROOF_ORDER.filter((k) => kinds.includes(k) && (k !== 'passkey' || passkeys));
}

const SIX_DIGITS = /^\d{6}$/;

async function factorProofCode(): Promise<{ challengeId?: number | string }> {
  return api.post<{ challengeId?: number }>('/v1/users/me/mfa/factor-proof', { kind: 'code' });
}

async function factorProofPasskeyOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const data = await api.post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    '/v1/users/me/mfa/factor-proof',
    { kind: 'passkey' },
  );
  return data.options;
}

/**
 * Asks the signed-in user to prove the account again: a passkey, an
 * authenticator code, an emailed or texted code, or the password, whichever
 * the account has. Reports the finished proof through `onChange` (null while
 * incomplete). An emailed or texted code is sent as soon as that kind is
 * chosen and kept while the field stays mounted. After a failed call that
 * carried the proof, pass a new `rejection`: each proof works once, so the
 * field asks for what the failure used up.
 */
export function FactorProofField({
  kinds,
  codeMethod,
  onChange,
  sendCode = factorProofCode,
  passkeyOptions = factorProofPasskeyOptions,
  idPrefix,
  description,
  rejection = null,
  showMissing = false,
}: {
  /** The kinds the account accepts (`factorProofKinds` of GET /v1/users/me/mfa). */
  kinds: readonly string[];
  /** The method a `code` proof is sent with (`email` or `sms`). */
  codeMethod?: string | null;
  onChange: (proof: FactorProof | null) => void;
  /** Sends the email or SMS code; answers its challenge id. */
  sendCode?: () => Promise<{ challengeId?: number | string }>;
  /** The options for the passkey prompt. */
  passkeyOptions?: () => Promise<PublicKeyCredentialRequestOptionsJSON>;
  idPrefix: string;
  description?: string;
  /** The last failure of a call that carried the proof. */
  rejection?: ProofRejection | null;
  /** The user tried to continue: say the proof is missing while it is. */
  showMissing?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const usable = useMemo(() => usableProofKinds(kinds), [kinds]);
  const [kind, setKind] = useState<FactorProofKind | undefined>(usable[0]);
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<number | undefined>(undefined);
  const [credential, setCredential] = useState<AuthenticationResponseJSON | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const codeRequested = useRef(false);
  const codeSentAt = useRef<number | null>(null);
  // A rejection the field mounted with belongs to an earlier field.
  const handledRejection = useRef(rejection);
  const passkeyPrompt = usePrefetchedOptions(
    passkeyOptions,
    kind === 'passkey' && credential == null && !verifying,
  );

  // An SSO account without a password or factor proves itself with a recent SSO sign-in.
  const { data: ssoStatus } = useQuery({
    queryKey: MFA_STATUS_KEY,
    queryFn: () => api.get<MfaStatus>('/v1/users/me/mfa'),
    enabled: kinds.includes('sso'),
  });
  const ssoUntil = ssoStatus?.ssoProofUntil;
  const ssoFresh = ssoUntil != null && Date.parse(ssoUntil) > Date.now();

  const proof = useMemo<FactorProof | null>(() => {
    if (kind === 'sso') return ssoFresh ? { kind } : null;
    if (kind === 'password') return password !== '' ? { kind, password } : null;
    if (kind === 'recovery_code') {
      const typed = recoveryCode.trim();
      return typed !== '' ? { kind, recoveryCode: typed } : null;
    }
    if (kind === 'totp') return SIX_DIGITS.test(code) ? { kind, code } : null;
    if (kind === 'code') {
      return challengeId != null && SIX_DIGITS.test(code) ? { kind, code, challengeId } : null;
    }
    if (kind === 'passkey') return credential != null ? { kind, credential } : null;
    return null;
  }, [kind, password, recoveryCode, code, challengeId, credential, ssoFresh]);

  useEffect(() => {
    onChangeRef.current(proof);
  }, [proof]);

  function codeFresh(): boolean {
    return codeSentAt.current != null && Date.now() - codeSentAt.current < CODE_MAX_AGE_MS;
  }

  async function requestCode(): Promise<void> {
    setSending(true);
    setError('');
    try {
      const data = await sendCode();
      if (data.challengeId != null) {
        setChallengeId(Number(data.challengeId));
        codeSentAt.current = Date.now();
      }
    } catch (err) {
      // A resend limit names its own wait (MFA_RESEND_LIMITED), more useful than the generic 429 text.
      setError(getErrorMessage(err, t, 'factorProof.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (kind !== 'code' || codeRequested.current) return;
    codeRequested.current = true;
    // The code goes out once while it is valid; a new code is the user's call.
    void requestCode();
  }, [kind]);

  // A failed call used up what it carried: a passkey response and a TOTP code always, an
  // emailed or texted code unless the API refused only the code (still valid), a password only
  // when it was wrong.
  useEffect(() => {
    if (rejection == null || rejection === handledRejection.current) return;
    handledRejection.current = rejection;
    setCode('');
    setRecoveryCode('');
    setCredential(null);
    setNotice('');
    if (rejection.code === 'INVALID_PASSWORD') setPassword('');
    const codeStillValid = rejection.code === 'MFA_CODE_INVALID' && codeFresh();
    if (kind !== 'code' || codeStillValid) return;
    setChallengeId(undefined);
    codeSentAt.current = null;
    codeRequested.current = true;
    void requestCode();
  }, [rejection]);

  async function verifyPasskey(): Promise<void> {
    setVerifying(true);
    setError('');
    setNotice('');
    try {
      // Prefetched options start the prompt inside the click (Safari needs that).
      const optionsJSON = passkeyPrompt.take() ?? (await passkeyPrompt.load());
      setCredential(await startAuthentication({ optionsJSON }));
    } catch (err) {
      const text = passkeyErrorText(err, t);
      if (text.quiet) setNotice(text.message);
      else setError(text.message);
    } finally {
      setVerifying(false);
    }
  }

  function choose(next: FactorProofKind): void {
    setKind(next);
    setPassword('');
    setRecoveryCode('');
    setCode('');
    setCredential(null);
    setError('');
    setNotice('');
    // Switching back to the code reuses the one sent while it is still valid.
    if (next !== 'code' || codeFresh()) return;
    codeRequested.current = false;
    setChallengeId(undefined);
  }

  if (kinds.length === 0) return null;
  if (usable.length === 0) {
    return (
      <Alert variant="info">
        <Info className="h-4 w-4" />
        <AlertDescription>{t('factorProof.passkeyNeedsSecurePage')}</AlertDescription>
      </Alert>
    );
  }

  const kindLabel = (k: FactorProofKind): string =>
    t(
      (k === 'code' && codeMethod === 'sms'
        ? 'factorProof.kindCodeSms'
        : KIND_LABELS[k]) as 'factorProof.kindPasskey',
    );

  return (
    <div className="space-y-3" data-testid="factor-proof">
      {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
      {usable.length > 1 && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-kind`} className="leading-6">
            {t('factorProof.chooseLabel')}
          </Label>
          <Select
            id={`${idPrefix}-kind`}
            value={kind}
            onChange={(e) => {
              choose(e.target.value as FactorProofKind);
            }}
          >
            {usable.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </Select>
        </div>
      )}
      {kind === 'password' && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-password`} className="leading-6">
            {t('profile.currentPassword')}
          </Label>
          <PasswordInput
            id={`${idPrefix}-password`}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="current-password"
          />
        </div>
      )}
      {kind === 'recovery_code' && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-recovery-code`} className="leading-6">
            {t('factorProof.recoveryCodeLabel')}
          </Label>
          <Input
            id={`${idPrefix}-recovery-code`}
            value={recoveryCode}
            onChange={(e) => {
              setRecoveryCode(e.target.value);
            }}
            placeholder="xxxxx-xxxxx"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="max-w-[200px]"
          />
        </div>
      )}
      {(kind === 'totp' || kind === 'code') && (
        <div className="space-y-2">
          {kind === 'code' && (
            <LiveStatus
              message={
                challengeId != null
                  ? t(
                      codeMethod === 'sms'
                        ? 'factorProof.codeSentSms'
                        : 'factorProof.codeSentEmail',
                    )
                  : null
              }
            />
          )}
          <Label htmlFor={`${idPrefix}-code`} className="leading-6">
            {t(kind === 'totp' ? 'factorProof.totpLabel' : 'factorProof.codeLabel')}
          </Label>
          <Input
            id={`${idPrefix}-code`}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.trim());
            }}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="max-w-[200px]"
          />
          {kind === 'code' && (
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => {
                void requestCode();
              }}
            >
              {sending ? t('factorProof.sending') : t('factorProof.resend')}
            </Button>
          )}
        </div>
      )}
      {kind === 'sso' &&
        (ssoFresh ? (
          <p className="text-sm text-success" role="status">
            {t('factorProof.ssoConfirmed')}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('factorProof.ssoHint')}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                startSsoSignIn(
                  `${window.location.pathname}${window.location.search}${window.location.hash}`,
                );
              }}
            >
              {t('factorProof.ssoSignIn')}
            </Button>
          </div>
        ))}
      {kind === 'passkey' && credential == null && (
        <Button
          type="button"
          variant="outline"
          disabled={verifying}
          onClick={() => {
            void verifyPasskey();
          }}
        >
          {verifying ? t('factorProof.verifying') : t('factorProof.passkeyButton')}
        </Button>
      )}
      <LiveStatus
        message={
          kind === 'passkey' && credential != null ? t('factorProof.passkeyVerified') : notice
        }
        className={kind === 'passkey' && credential != null ? 'text-success' : undefined}
      />
      {error !== '' && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {showMissing && proof == null && error === '' && (
        <p className="text-sm text-destructive" role="alert">
          {t('factorProof.confirmFirst')}
        </p>
      )}
    </div>
  );
}
