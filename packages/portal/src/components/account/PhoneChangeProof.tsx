// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import type { PortalMfaStatus } from '@/lib/mfa-status';

/** What a phone change sends next to the number. */
export interface PhoneChangeExtras {
  proof?: FactorProof;
  phoneVerification?: { challengeId: number; code: string };
}

/** Whether changing the phone needs more than the number: the driver holds a factor. */
export function phoneChangeNeedsProof(status: PortalMfaStatus | undefined): boolean {
  return (status?.factorProofKinds ?? []).some((kind) => kind !== 'password');
}

/**
 * The confirmation a phone change of a driver with a factor needs: the fresh
 * proof, and for a driver that signs in with SMS codes the code texted to the
 * new number (sent after the proof). Reports what to send, null while
 * incomplete.
 */
export function PhoneChangeProof({
  phone,
  status,
  onChange,
  rejection = null,
  showMissing = false,
}: {
  phone: string;
  status: PortalMfaStatus;
  onChange: (extras: PhoneChangeExtras | null) => void;
  /** The last failure of a save that carried the proof or the code. */
  rejection?: ProofRejection | null;
  showMissing?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const sms = status.mfaEnabled && status.mfaMethod === 'sms';
  const number = phone.trim();
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [challengeId, setChallengeId] = useState<number | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (rejection != null) setProofFailure(rejection);
  }, [rejection]);

  const codeSent = challengeId != null && sentTo === number;

  useEffect(() => {
    if (!sms) {
      onChange(proof != null ? { proof } : null);
      return;
    }
    onChange(
      codeSent && /^\d{6}$/.test(code) ? { phoneVerification: { challengeId, code } } : null,
    );
  }, [sms, proof, codeSent, challengeId, code, onChange]);

  async function sendCode(): Promise<void> {
    setError('');
    if (proof == null) {
      setError(t('factorProof.confirmFirst'));
      return;
    }
    setSending(true);
    try {
      const res = await api.post<{ challengeId: number }>('/v1/portal/driver/phone-verification', {
        phone: number,
        proof,
      });
      setChallengeId(res.challengeId);
      setSentTo(number);
      setCode('');
    } catch (err) {
      // Each proof works once: ask for what the failure used up.
      setProofFailure(proofRejection(err));
      setError(getErrorMessage(err, t, 'profile.phoneCodeSendFailed'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="phone-change-proof">
      <p className="text-sm text-muted-foreground">
        {t(sms ? 'profile.phoneChangeSmsHint' : 'profile.phoneChangeProofHint')}
      </p>
      {!codeSent && (
        <FactorProofField
          idPrefix="phone-proof"
          kinds={status.factorProofKinds ?? []}
          codeMethod={status.mfaMethod}
          onChange={setProof}
          rejection={proofFailure}
          showMissing={showMissing && !sms}
        />
      )}
      {sms && !codeSent && (
        <Button
          type="button"
          variant="outline"
          disabled={sending || number === ''}
          onClick={() => void sendCode()}
        >
          {t('profile.phoneSendCode')}
        </Button>
      )}
      {sms && codeSent && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('profile.phoneCodeSent', { phone: number })}
          </p>
          <label htmlFor="phone-code" className="block text-sm font-medium leading-none">
            {t('profile.phoneCode')}
          </label>
          <Input
            id="phone-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
            }}
          />
        </div>
      )}
      {sms && showMissing && !codeSent && error === '' && (
        <p className="text-sm text-destructive" role="alert">
          {t('profile.phoneCodeRequired')}
        </p>
      )}
      {error !== '' && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
