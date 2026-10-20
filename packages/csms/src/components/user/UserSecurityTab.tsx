// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { generateRandomPassword } from '@/lib/generate-password';
import { passwordRulesMessage } from '@/lib/password-rules';
import { usePasswordPolicy, useWeakPasswordReply } from '@/hooks/use-password-policy';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import type { PasswordRule } from '@evtivity/lib/password-policy';

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

  const resetPasswordMutation = useMutation({
    mutationFn: (body: { password: string }) =>
      api.post<{ success: boolean }>(`/v1/users/${userId}/reset-password`, body),
    onSuccess: () => {
      setNewPassword('');
      setHasSubmittedPassword(false);
    },
    onError: (err: unknown) => {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerMissing(weakPasswordReply(err) ?? []);
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
    resetPasswordMutation.mutate({ password: newPassword });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('users.resetPassword')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">{t('users.resetPasswordDescription')}</p>
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
          <Button type="submit" className="w-fit" disabled={resetPasswordMutation.isPending}>
            {t('users.resetPassword')}
          </Button>
          {resetPasswordMutation.isError &&
            getApiErrorCode(resetPasswordMutation.error) !== 'WEAK_PASSWORD' && (
              <p className="text-sm text-destructive">
                {getErrorMessage(resetPasswordMutation.error, t)}
              </p>
            )}
          {resetPasswordMutation.isSuccess && (
            <p className="text-sm text-success">{t('users.passwordResetSuccess')}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
