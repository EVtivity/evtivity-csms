// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';
import { getErrorMessage } from '@/lib/error-message';

export interface SsoLinkCardProps {
  /** The account is bound to its identity provider user. */
  linked: boolean;
  /** SSO may link the account at its next sign-in. */
  allowed: boolean;
  /** Allows the link with the fresh proof of the signed-in account. */
  allow: (proof: FactorProof | undefined) => Promise<unknown>;
  /** Withdraws an allowed link (admins only); omitted hides the button. */
  withdraw?: () => Promise<unknown>;
  /** Removes a binding with the fresh proof (admins only); omitted hides the button. */
  unlink?: (proof: FactorProof | undefined) => Promise<unknown>;
  onChanged: () => void;
}

/**
 * Whether single sign-on may sign in as an existing password account: SSO
 * binds an account to its identity provider user only after
 * the link is allowed, by an admin on the user's Security tab or by the user in
 * the profile. Allowing it takes a fresh proof of the signed-in account.
 */
export function SsoLinkCard({
  linked,
  allowed,
  allow,
  withdraw,
  unlink,
  onChanged,
}: SsoLinkCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  // The action the proof field confirms: allowing the link, or removing a binding.
  const [asking, setAsking] = useState<'allow' | 'unlink' | null>(null);
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [proofRound, setProofRound] = useState(0);

  const allowMutation = useMutation({
    mutationFn: (sent: FactorProof | undefined) =>
      asking === 'unlink' && unlink != null ? unlink(sent) : allow(sent),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: () => {
      setAsking(null);
      onChanged();
    },
  });
  const withdrawMutation = useMutation({
    mutationFn: () => (withdraw != null ? withdraw() : Promise.resolve()),
    onSuccess: onChanged,
  });

  function start(action: 'allow' | 'unlink'): void {
    setProof(null);
    setProofFailure(null);
    setProofAsked(false);
    setProofRound((n) => n + 1);
    allowMutation.reset();
    setAsking(action);
  }

  function confirm(): void {
    if (proofKinds.length > 0 && proof == null) {
      setProofAsked(true);
      return;
    }
    allowMutation.mutate(proof ?? undefined);
  }

  return (
    <TabPanel title={t('users.ssoLinkTitle')} bodyClassName="space-y-4">
      <p className="text-sm text-muted-foreground">{t('users.ssoLinkDescription')}</p>
      {asking != null ? (
        <div className="space-y-4">
          {proofKinds.length > 0 && (
            <FactorProofField
              key={`sso-link-${String(proofRound)}`}
              idPrefix="sso-link-proof"
              kinds={proofKinds}
              codeMethod={mfaStatus?.mfaMethod ?? null}
              description={t(
                asking === 'unlink' ? 'users.ssoUnlinkProofHint' : 'users.ssoLinkProofHint',
              )}
              onChange={setProof}
              rejection={proofFailure}
              showMissing={proofAsked}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAsking(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={allowMutation.isPending} onClick={confirm}>
              {t(asking === 'unlink' ? 'users.ssoUnlink' : 'users.ssoLinkAllow')}
            </Button>
          </div>
        </div>
      ) : linked ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">{t('users.ssoLinked')}</p>
          {unlink != null && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                start('unlink');
              }}
            >
              {t('users.ssoUnlink')}
            </Button>
          )}
        </div>
      ) : allowed ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">{t('users.ssoLinkPending')}</p>
          {withdraw != null && (
            <Button
              type="button"
              variant="outline"
              disabled={withdrawMutation.isPending}
              onClick={() => {
                withdrawMutation.mutate();
              }}
            >
              {t('users.ssoLinkWithdraw')}
            </Button>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            start('allow');
          }}
        >
          {t('users.ssoLinkAllow')}
        </Button>
      )}
      {(allowMutation.isError || withdrawMutation.isError) && (
        <p className="text-sm text-destructive" role="alert">
          {getErrorMessage(allowMutation.error ?? withdrawMutation.error, t)}
        </p>
      )}
    </TabPanel>
  );
}
