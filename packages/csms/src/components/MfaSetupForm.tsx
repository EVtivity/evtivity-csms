// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { rateLimitedMessage } from '@/lib/error-message';

export const MFA_METHOD_LABELS: Record<string, string> = {
  email: 'profile.mfaMethodEmail',
  totp: 'profile.mfaMethodTotp',
  sms: 'profile.mfaMethodSms',
};

/** POST /v1/users/me/mfa/setup: the TOTP secret and QR code, or the email or SMS challenge. */
export interface MfaSetupResponse {
  qrDataUri?: string;
  secret?: string;
  challengeId?: string | number;
}

export interface MfaConfirmBody {
  method: string;
  code: string;
  challengeId?: string;
}

function isInvalidPassword(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const body = err.body as { code?: unknown } | null;
  return body != null && typeof body === 'object' && body.code === 'INVALID_PASSWORD';
}

/**
 * Method choice, then the QR code or the sent code, then the 6-digit check.
 * Used by Profile > Two-Factor Authentication and by the MFA setup a required
 * MFA sign-in opens; the caller decides which credentials the calls use.
 */
export function MfaSetupForm<T>({
  availableMethods,
  setup,
  confirm,
  onConfirmed,
  proofReady = true,
  onProofMissing,
  children,
}: {
  availableMethods: string[];
  setup: (method: string) => Promise<MfaSetupResponse>;
  confirm: (body: MfaConfirmBody) => Promise<T>;
  onConfirmed: (data: T) => void;
  /** False while a proof field above it is incomplete: Set Up then sends nothing. */
  proofReady?: boolean;
  /** Set Up was clicked without the proof, so the proof field can say so. */
  onProofMissing?: () => void;
  /** Shown above the method choice, such as the status badge. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [method, setMethod] = useState(
    availableMethods.length === 1 ? (availableMethods[0] ?? '') : '',
  );
  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const methodError = method === '' ? t('validation.selectRequired') : null;

  const setupMutation = useMutation({
    mutationFn: (selected: string) => setup(selected),
    onSuccess: (data) => {
      setSetupData(data);
      setCode('');
      setError('');
    },
    onError: (err) => {
      setError(rateLimitedMessage(err, t) ?? t('profile.mfaSetupFailed'));
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (body: MfaConfirmBody) => confirm(body),
    onSuccess: (data) => {
      setSetupData(null);
      setCode('');
      setMethod('');
      setError('');
      onConfirmed(data);
    },
    onError: (err) => {
      setError(
        rateLimitedMessage(err, t) ??
          (isInvalidPassword(err) ? t('errors.INVALID_PASSWORD') : t('profile.mfaVerifyFailed')),
      );
    },
  });

  if (setupData == null) {
    return (
      <div className="space-y-4 max-w-md">
        {children}
        {error !== '' && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="mfa-method-select" className="leading-6">
            {t('profile.mfaSelectMethod')}
          </Label>
          <Select
            id="mfa-method-select"
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
            }}
            className={hasSubmitted && methodError != null ? 'border-destructive' : ''}
          >
            <option value="">{t('profile.mfaSelectMethod')}</option>
            {availableMethods.map((m) => (
              <option key={m} value={m}>
                {t((MFA_METHOD_LABELS[m] ?? m) as never)}
              </option>
            ))}
          </Select>
          {hasSubmitted && methodError != null && (
            <p className="text-sm text-destructive" role="alert">
              {methodError}
            </p>
          )}
        </div>
        <Button
          disabled={setupMutation.isPending}
          onClick={() => {
            setHasSubmitted(true);
            if (!proofReady) onProofMissing?.();
            if (methodError != null || !proofReady) return;
            setError('');
            setupMutation.mutate(method);
          }}
        >
          {setupMutation.isPending ? t('profile.mfaSettingUp') : t('profile.mfaSetUp')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-md">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      {setupData.qrDataUri != null && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('profile.mfaScanQr')}</p>
          <img
            src={setupData.qrDataUri}
            alt={t('profile.mfaQrCode')}
            className="rounded border p-2"
            width={200}
            height={200}
          />
          {setupData.secret != null && (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('profile.mfaManualEntry')}</p>
              <code className="block rounded bg-muted px-3 py-2 text-sm select-all">
                {setupData.secret}
              </code>
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="mfa-verify-code" className="leading-6">
          {t('profile.mfaEnterCode')}
        </Label>
        <Input
          id="mfa-verify-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
          maxLength={6}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          className="max-w-[200px]"
        />
      </div>
      <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
        <Button
          disabled={code.length !== 6 || confirmMutation.isPending}
          onClick={() => {
            setError('');
            confirmMutation.mutate({
              method,
              code,
              ...(setupData.challengeId != null
                ? { challengeId: String(setupData.challengeId) }
                : {}),
            });
          }}
        >
          {confirmMutation.isPending ? t('profile.mfaVerifying') : t('profile.mfaVerify')}
        </Button>
        <CancelButton
          onClick={() => {
            setSetupData(null);
            setCode('');
            setError('');
          }}
        />
      </div>
    </div>
  );
}
