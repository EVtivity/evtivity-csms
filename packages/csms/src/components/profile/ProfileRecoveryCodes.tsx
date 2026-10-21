// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CancelButton } from '@/components/cancel-button';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface RegenerateResponse {
  recoveryCodes?: string[];
  challengeId?: number | string;
}

const REGENERATE_PATH = '/v1/users/me/mfa/recovery-codes';

/** The proofs the regenerate route takes: a code of the current method, or a passkey. */
export function recoveryProofKinds(method: string, passkeyCount: number): string[] {
  const kinds: string[] = [];
  if (method === 'totp') kinds.push('totp');
  if (method === 'email' || method === 'sms') kinds.push('code');
  if (passkeyCount > 0) kinds.push('passkey');
  return kinds;
}

function regenerateBody(proof: FactorProof): Record<string, unknown> {
  if (proof.kind === 'passkey') return { credential: proof.credential };
  return {
    code: proof.code,
    ...(proof.challengeId != null ? { challengeId: proof.challengeId } : {}),
  };
}

/**
 * The recovery codes part of the MFA card: how many are left and Regenerate,
 * which asks for a proof (a code of the current method, an email or SMS code
 * sent first, or a passkey) and then shows the new codes once through `onCodes`.
 */
export function ProfileRecoveryCodes({
  method,
  remaining,
  usedUp = false,
  passkeyCount = 0,
  onCodes,
}: {
  method: string;
  remaining: number;
  /** Every code the account was given is used: a different hint than for an account without codes. */
  usedUp?: boolean;
  /** Passkeys and security keys of the account: one of them can prove it too. */
  passkeyCount?: number;
  onCodes: (codes: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [rejection, setRejection] = useState<ProofRejection | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [error, setError] = useState('');

  function close(): void {
    setProofOpen(false);
    setProof(null);
    setRejection(null);
    setHasSubmitted(false);
    setError('');
  }

  const regenerateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<RegenerateResponse>(REGENERATE_PATH, body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['mfa-status'] });
      close();
      if (data.recoveryCodes != null) onCodes(data.recoveryCodes);
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, t, 'profile.mfaVerifyFailed'));
      // Each proof works once: the field asks for what the failed call used up.
      setRejection(proofRejection(err));
      setHasSubmitted(false);
    },
  });

  function startProof(): void {
    setError('');
    setProofOpen(true);
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground" data-testid="recovery-codes-remaining">
        {remaining === 0
          ? t(usedUp ? 'profile.recoveryCodesUsedUp' : 'profile.recoveryCodesNone')
          : t('profile.recoveryCodesRemaining', { count: remaining })}
      </p>
      {proofOpen ? (
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setHasSubmitted(true);
            if (proof == null) return;
            setError('');
            regenerateMutation.mutate(regenerateBody(proof));
          }}
        >
          <FactorProofField
            idPrefix="recovery-proof"
            kinds={recoveryProofKinds(method, passkeyCount)}
            codeMethod={method}
            description={t('profile.recoveryCodesProof')}
            onChange={setProof}
            rejection={rejection}
            showMissing={hasSubmitted}
            sendCode={() => api.post<RegenerateResponse>(REGENERATE_PATH, {})}
            passkeyOptions={() =>
              api.post<PublicKeyCredentialRequestOptionsJSON>(
                '/v1/users/me/mfa/recovery-codes/webauthn-options',
                {},
              )
            }
          />
          {error !== '' && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={regenerateMutation.isPending}>
              {regenerateMutation.isPending
                ? t('profile.mfaVerifying')
                : t('profile.recoveryCodesRegenerate')}
            </Button>
            <CancelButton onClick={close} />
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          onClick={() => {
            // With no codes left nothing is replaced, so there is nothing to confirm.
            if (remaining === 0) startProof();
            else setConfirmOpen(true);
          }}
        >
          {t('profile.recoveryCodesRegenerate')}
        </Button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('profile.recoveryCodesRegenerate')}
        description={t('profile.recoveryCodesRegenerateConfirm')}
        confirmLabel={t('profile.recoveryCodesRegenerate')}
        variant="default"
        onConfirm={startProof}
      />
    </div>
  );
}
