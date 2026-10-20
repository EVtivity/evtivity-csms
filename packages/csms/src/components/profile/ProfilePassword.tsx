// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { api, getApiErrorCode } from '@/lib/api';
import { passwordRulesMessage } from '@/lib/password-rules';
import { usePasswordPolicy, useWeakPasswordReply } from '@/hooks/use-password-policy';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import type { PasswordRule } from '@evtivity/lib/password-policy';

export function ProfilePassword(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const passwordPolicy = usePasswordPolicy();
  const weakPasswordReply = useWeakPasswordReply();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  // The rules a WEAK_PASSWORD reply named. Translated at render, cleared on edit.
  const [serverMissing, setServerMissing] = useState<PasswordRule[] | null>(null);

  const changePasswordMutation = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.post('/v1/users/me/change-password', body),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
      setHasSubmittedPassword(false);
      setPasswordSuccess(true);
      setTimeout(() => {
        setPasswordSuccess(false);
      }, 3000);
    },
    onError: (err: unknown) => {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') {
        setServerMissing(weakPasswordReply(err) ?? []);
      } else if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setPasswordError(body.error ?? t('profile.passwordChangeFailed'));
      } else {
        setPasswordError(t('profile.passwordChangeFailed'));
      }
    },
  });

  function getPasswordValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (currentPassword.trim() === '') {
      errors.currentPassword = t('validation.required');
    }
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
    if (confirmPassword.trim() === '') {
      errors.confirmPassword = t('validation.required');
    } else if (newPassword !== confirmPassword) {
      errors.confirmPassword = t('validation.passwordMismatch');
    }
    return errors;
  }

  const passwordValidationErrors = getPasswordValidationErrors();

  function handleChangePassword(e: React.SyntheticEvent): void {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess(false);
    setHasSubmittedPassword(true);
    if (Object.keys(passwordValidationErrors).length > 0) return;

    changePasswordMutation.mutate({ currentPassword, newPassword });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.changePassword')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleChangePassword} noValidate className="space-y-4 max-w-md">
          {passwordError !== '' && <p className="text-sm text-destructive">{passwordError}</p>}
          {passwordSuccess && (
            <p className="text-sm text-green-600">{t('profile.passwordChanged')}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="current-password" className="leading-6">
              {t('profile.currentPassword')}
            </Label>
            <PasswordInput
              id="current-password"
              value={currentPassword}
              onChange={(e) => {
                setCurrentPassword(e.target.value);
              }}
              autoComplete="current-password"
              className={
                hasSubmittedPassword && passwordValidationErrors.currentPassword
                  ? 'border-destructive'
                  : ''
              }
            />
            {hasSubmittedPassword && passwordValidationErrors.currentPassword && (
              <p className="text-sm text-destructive">{passwordValidationErrors.currentPassword}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password" className="leading-6">
              {t('profile.newPassword')}
            </Label>
            <PasswordInput
              id="new-password"
              value={newPassword}
              aria-invalid={
                hasSubmittedPassword && passwordValidationErrors.newPassword ? true : undefined
              }
              aria-describedby={
                hasSubmittedPassword && passwordValidationErrors.newPassword
                  ? 'new-password-error new-password-requirements'
                  : 'new-password-requirements'
              }
              onChange={(e) => {
                setNewPassword(e.target.value);
                setServerMissing(null);
              }}
              autoComplete="new-password"
              className={
                hasSubmittedPassword && passwordValidationErrors.newPassword
                  ? 'border-destructive'
                  : ''
              }
            />
            {hasSubmittedPassword && passwordValidationErrors.newPassword && (
              <p id="new-password-error" className="text-sm text-destructive">
                {passwordValidationErrors.newPassword}
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
          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="leading-6">
              {t('profile.confirmPassword')}
            </Label>
            <PasswordInput
              id="confirm-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
              }}
              autoComplete="new-password"
              className={
                hasSubmittedPassword && passwordValidationErrors.confirmPassword
                  ? 'border-destructive'
                  : ''
              }
            />
            {hasSubmittedPassword && passwordValidationErrors.confirmPassword && (
              <p className="text-sm text-destructive">{passwordValidationErrors.confirmPassword}</p>
            )}
          </div>
          <Button type="submit" disabled={changePasswordMutation.isPending}>
            {t('profile.changePassword')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
