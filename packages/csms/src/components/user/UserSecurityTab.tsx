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
import { missingPasswordRules } from '@evtivity/lib/password-policy';
import { api, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { passwordRulesMessage } from '@/lib/password-rules';
import { PasswordRequirements } from '@/components/PasswordRequirements';

export interface UserSecurityTabProps {
  userId: string;
}

// Draws until the password meets every rule of the API (`@evtivity/lib/password-policy`).
function generateRandomPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  for (;;) {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    const password = Array.from(array, (b) => chars[b % chars.length]).join('');
    if (missingPasswordRules(password).length === 0) return password;
  }
}

export function UserSecurityTab({ userId }: UserSecurityTabProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [newPassword, setNewPassword] = useState('');
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  // The API refused the password (WEAK_PASSWORD). Translated at render, cleared on edit.
  const [serverWeakPassword, setServerWeakPassword] = useState(false);

  const resetPasswordMutation = useMutation({
    mutationFn: (body: { password: string }) =>
      api.post<{ success: boolean }>(`/v1/users/${userId}/reset-password`, body),
    onSuccess: () => {
      setNewPassword('');
      setHasSubmittedPassword(false);
    },
    onError: (err: unknown) => {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerWeakPassword(true);
    },
  });

  function getPasswordValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (newPassword.trim() === '') {
      errors.newPassword = t('validation.required');
    } else {
      const rulesError = passwordRulesMessage(newPassword, t, i18n.language);
      if (rulesError != null) errors.newPassword = rulesError;
      else if (serverWeakPassword) errors.newPassword = t('errors.WEAK_PASSWORD');
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
                aria-describedby="new-password-requirements"
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setServerWeakPassword(false);
                }}
                className={
                  hasSubmittedPassword && passwordErrors.newPassword ? 'border-destructive' : ''
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setNewPassword(generateRandomPassword());
                  setServerWeakPassword(false);
                }}
              >
                <RefreshCw className="h-4 w-4" />
                {t('users.generatePassword')}
              </Button>
            </div>
            {hasSubmittedPassword && passwordErrors.newPassword && (
              <p className="text-sm text-destructive">{passwordErrors.newPassword}</p>
            )}
            <PasswordRequirements
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
