// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { TabPanel } from '@/components/ui/tab-panel';
import { api, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { generateRandomPassword } from '@/lib/generate-password';
import { passwordRulesMessage } from '@/lib/password-rules';
import { usePasswordPolicy, useWeakPasswordReply } from '@/hooks/use-password-policy';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import type { PasswordRule } from '@evtivity/lib/password-policy';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';

export interface UserSecurityTabProps {
  userId: string;
}

export function UserSecurityTab({ userId }: UserSecurityTabProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const passwordPolicy = usePasswordPolicy();
  const weakPasswordReply = useWeakPasswordReply();
  const [newPassword, setNewPassword] = useState('');
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  // The rules a WEAK_PASSWORD reply named. Translated at render, cleared on edit.
  const [serverMissing, setServerMissing] = useState<PasswordRule[] | null>(null);
  // Resetting another account's password takes a fresh proof of the signed-in account.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofRound, setProofRound] = useState(0);

  const resetPasswordMutation = useMutation({
    mutationFn: (body: { password: string; proof?: FactorProof }) =>
      api.post<{ success: boolean }>(`/v1/users/${userId}/reset-password`, body),
    onSuccess: () => {
      setNewPassword('');
      setHasSubmittedPassword(false);
      setProof(null);
      setProofFailure(null);
      setProofRound((n) => n + 1);
    },
    onError: (err: unknown) => {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerMissing(weakPasswordReply(err) ?? []);
      else setProofFailure(proofRejection(err));
    },
  });

  function getPasswordValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (newPassword.trim() === '') {
      errors.newPassword = t('validation.required');
    } else {
      const rulesError = passwordRulesMessage(
        newPassword,
        passwordPolicy,
        t,
        i18n.language,
        serverMissing,
      );
      if (rulesError != null) errors.newPassword = rulesError;
    }
    return errors;
  }

  const passwordErrors = getPasswordValidationErrors();

  function handleResetPassword(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmittedPassword(true);
    if (Object.keys(passwordErrors).length > 0) return;
    if (proofKinds.length > 0 && proof == null) return;
    resetPasswordMutation.mutate({
      password: newPassword,
      ...(proof != null ? { proof } : {}),
    });
  }

  return (
    <TabPanel title={t('users.securityTab')} description={t('users.resetPasswordDescription')}>
      <form onSubmit={handleResetPassword} noValidate className="grid gap-6">
        <div className="space-y-2">
          <Label htmlFor="new-password" className="leading-6">
            {t('users.newPassword')}
          </Label>
          <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
            <PasswordInput
              id="new-password"
              value={newPassword}
              aria-invalid={hasSubmittedPassword && passwordErrors.newPassword ? true : undefined}
              aria-describedby={
                hasSubmittedPassword && passwordErrors.newPassword
                  ? 'new-password-error new-password-requirements'
                  : 'new-password-requirements'
              }
              onChange={(e) => {
                setNewPassword(e.target.value);
                setServerMissing(null);
                resetPasswordMutation.reset();
              }}
              className={
                hasSubmittedPassword && passwordErrors.newPassword ? 'border-destructive' : ''
              }
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setNewPassword(generateRandomPassword(passwordPolicy));
                setServerMissing(null);
                resetPasswordMutation.reset();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {t('users.generatePassword')}
            </Button>
          </div>
          {hasSubmittedPassword && passwordErrors.newPassword && (
            <p id="new-password-error" className="text-sm text-destructive">
              {passwordErrors.newPassword}
            </p>
          )}
          <PasswordRequirements
            policy={passwordPolicy}
            serverMissing={serverMissing}
            id="new-password-requirements"
            password={newPassword}
            showUnmet={hasSubmittedPassword}
          />
        </div>
        {proofKinds.length > 0 && (
          <FactorProofField
            key={`reset-${String(proofRound)}`}
            idPrefix="user-reset-proof"
            kinds={proofKinds}
            codeMethod={mfaStatus?.mfaMethod ?? null}
            description={t('users.resetProofHint')}
            onChange={setProof}
            rejection={proofFailure}
            showMissing={hasSubmittedPassword}
          />
        )}
        <Button type="submit" className="relative w-fit" disabled={resetPasswordMutation.isPending}>
          {resetPasswordMutation.isPending && (
            <span className="absolute inset-0 flex items-center justify-center">
              <Spinner className="h-4 w-4" />
            </span>
          )}
          <span className={resetPasswordMutation.isPending ? 'invisible' : ''}>
            {t('users.resetPassword')}
          </span>
        </Button>
        {resetPasswordMutation.isError &&
          getApiErrorCode(resetPasswordMutation.error) !== 'WEAK_PASSWORD' && (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(resetPasswordMutation.error, t)}
            </p>
          )}
        {resetPasswordMutation.isSuccess && (
          <p className="text-sm text-success">{t('users.passwordResetSuccess')}</p>
        )}
      </form>
    </TabPanel>
  );
}
