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
import { api } from '@/lib/api';

export interface UserSecurityTabProps {
  userId: string;
}

function generateRandomPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
}

export function UserSecurityTab({ userId }: UserSecurityTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState('');
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);

  const resetPasswordMutation = useMutation({
    mutationFn: (body: { password: string }) =>
      api.post<{ success: boolean }>(`/v1/users/${userId}/reset-password`, body),
    onSuccess: () => {
      setNewPassword('');
      setHasSubmittedPassword(false);
    },
  });

  function getPasswordValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (newPassword.trim() === '') {
      errors.newPassword = t('validation.required');
    } else if (newPassword.length < 8) {
      errors.newPassword = t('validation.minLength', { min: 8 });
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
            <Label htmlFor="new-password">{t('users.newPassword')}</Label>
            <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
              <PasswordInput
                id="new-password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
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
                }}
              >
                <RefreshCw className="h-4 w-4" />
                {t('users.generatePassword')}
              </Button>
            </div>
            {hasSubmittedPassword && passwordErrors.newPassword && (
              <p className="text-sm text-destructive">{passwordErrors.newPassword}</p>
            )}
          </div>
          <Button type="submit" className="w-fit" disabled={resetPasswordMutation.isPending}>
            {t('users.resetPassword')}
          </Button>
          {resetPasswordMutation.isSuccess && (
            <p className="text-sm text-success">{t('users.passwordResetSuccess')}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
