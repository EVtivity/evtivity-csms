// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { api, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { passwordRulesMessage } from '@/lib/password-rules';
import { usePasswordPolicy, useWeakPasswordReply } from '@/hooks/use-password-policy';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import type { PasswordRule } from '@evtivity/lib/password-policy';

export function AccountSecurity(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const passwordPolicy = usePasswordPolicy();
  const weakPasswordReply = useWeakPasswordReply();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  // The rules a WEAK_PASSWORD reply named. Translated at render, cleared on edit.
  const [serverMissing, setServerMissing] = useState<PasswordRule[] | null>(null);

  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaMethod, setMfaMethod] = useState<string | null>(null);
  const [availableMethods, setAvailableMethods] = useState<string[]>([]);
  const [selectedMfaMethod, setSelectedMfaMethod] = useState('');
  const [mfaSetupData, setMfaSetupData] = useState<{
    qrDataUri?: string;
    secret?: string;
    challengeId?: string;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMsg, setMfaMsg] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [hasSubmittedMfa, setHasSubmittedMfa] = useState(false);

  useEffect(() => {
    void api
      .get<{
        mfaEnabled: boolean;
        mfaMethod: string | null;
        availableMethods: string[];
      }>('/v1/portal/driver/mfa')
      .then((data) => {
        setMfaEnabled(data.mfaEnabled);
        setMfaMethod(data.mfaMethod);
        setAvailableMethods(data.availableMethods);
        if (data.availableMethods.length > 0) setSelectedMfaMethod(data.availableMethods[0] ?? '');
      });
  }, []);

  function getPasswordErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (currentPassword === '') errors.currentPassword = t('validation.required');
    if (newPassword === '') errors.newPassword = t('validation.required');
    else {
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

  const passwordErrors = getPasswordErrors();

  function getMfaErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (mfaEnabled) {
      if (disablePassword === '') errors.disablePassword = t('validation.required');
    } else if (mfaSetupData != null) {
      if (mfaCode.trim() === '') errors.mfaCode = t('validation.required');
      else if (!/^\d{6}$/.test(mfaCode.trim())) errors.mfaCode = t('profile.mfaEnterCode');
    }
    return errors;
  }

  const mfaErrors = getMfaErrors();

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handlePasswordChange(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedPassword(true);
    if (Object.keys(passwordErrors).length > 0) return;
    setPasswordMsg('');
    setPasswordLoading(true);
    try {
      await api.patch('/v1/portal/driver/password', { currentPassword, newPassword });
      setPasswordMsg(t('profile.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setHasSubmittedPassword(false);
    } catch (err) {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerMissing(weakPasswordReply(err) ?? []);
      else setPasswordMsg(getErrorMessage(err, t, 'profile.passwordChangeFailed'));
    } finally {
      setPasswordLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaSetup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedMfa(false);
    setMfaMsg('');
    setMfaLoading(true);
    try {
      const data = await api.post<{ qrDataUri?: string; secret?: string; challengeId?: string }>(
        '/v1/portal/driver/mfa/setup',
        { method: selectedMfaMethod },
      );
      setMfaSetupData(data);
    } catch (err) {
      setMfaMsg(getErrorMessage(err, t, 'profile.mfaSetupFailed'));
    } finally {
      setMfaLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaConfirm(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedMfa(true);
    if (Object.keys(mfaErrors).length > 0) return;
    setMfaMsg('');
    setMfaLoading(true);
    try {
      await api.post('/v1/portal/driver/mfa/confirm', {
        method: selectedMfaMethod,
        code: mfaCode.trim(),
        challengeId: mfaSetupData?.challengeId,
      });
      setMfaEnabled(true);
      setMfaMethod(selectedMfaMethod);
      setMfaSetupData(null);
      setMfaCode('');
      setHasSubmittedMfa(false);
    } catch (err) {
      setMfaMsg(getErrorMessage(err, t, 'profile.mfaVerifyFailed'));
    } finally {
      setMfaLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaDisable(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedMfa(true);
    if (Object.keys(mfaErrors).length > 0) return;
    setMfaMsg('');
    setMfaLoading(true);
    try {
      await api.delete('/v1/portal/driver/mfa', { password: disablePassword });
      setMfaEnabled(false);
      setMfaMethod(null);
      setDisablePassword('');
      setHasSubmittedMfa(false);
    } catch (err) {
      setMfaMsg(getErrorMessage(err, t, 'profile.mfaDisableFailed'));
    } finally {
      setMfaLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Password change */}
      <form onSubmit={(e) => void handlePasswordChange(e)} noValidate className="space-y-4">
        <h3 className="text-sm font-semibold">{t('profile.changePassword')}</h3>
        {passwordMsg !== '' && <p className="text-sm text-muted-foreground">{passwordMsg}</p>}
        <div className="space-y-2">
          <label htmlFor="secCurrentPw" className="block text-sm font-medium leading-6">
            {t('profile.currentPassword')}
          </label>
          <PasswordInput
            id="secCurrentPw"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
            }}
            className={
              hasSubmittedPassword && passwordErrors.currentPassword ? 'border-destructive' : ''
            }
          />
          {hasSubmittedPassword && passwordErrors.currentPassword && (
            <p className="text-sm text-destructive">{passwordErrors.currentPassword}</p>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="secNewPw" className="block text-sm font-medium leading-6">
            {t('profile.newPassword')}
          </label>
          <PasswordInput
            id="secNewPw"
            value={newPassword}
            aria-invalid={hasSubmittedPassword && passwordErrors.newPassword ? true : undefined}
            aria-describedby={
              hasSubmittedPassword && passwordErrors.newPassword
                ? 'sec-new-password-error sec-password-requirements'
                : 'sec-password-requirements'
            }
            onChange={(e) => {
              setNewPassword(e.target.value);
              setServerMissing(null);
            }}
            className={
              hasSubmittedPassword && passwordErrors.newPassword ? 'border-destructive' : ''
            }
          />
          {hasSubmittedPassword && passwordErrors.newPassword && (
            <p id="sec-new-password-error" className="text-sm text-destructive">
              {passwordErrors.newPassword}
            </p>
          )}
          <PasswordRequirements
            policy={passwordPolicy}
            serverMissing={serverMissing}
            id="sec-password-requirements"
            password={newPassword}
            showUnmet={hasSubmittedPassword}
          />
        </div>
        <Button type="submit" className="w-full" disabled={passwordLoading}>
          {passwordLoading ? t('profile.changingPassword') : t('profile.changePassword')}
        </Button>
      </form>

      {/* MFA */}
      {(mfaEnabled || availableMethods.length > 0) && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">{t('profile.mfaSecurity')}</h3>
          {mfaMsg !== '' && <p className="text-sm text-muted-foreground">{mfaMsg}</p>}

          {mfaEnabled ? (
            <div className="space-y-4">
              <p className="text-sm">
                {t('profile.mfaCurrentMethod')}:{' '}
                <span className="font-medium">
                  {mfaMethod === 'totp'
                    ? t('profile.mfaMethodTotp')
                    : mfaMethod === 'email'
                      ? t('profile.mfaMethodEmail')
                      : t('profile.mfaMethodSms')}
                </span>{' '}
                ({t('profile.mfaEnabled')})
              </p>
              <form onSubmit={(e) => void handleMfaDisable(e)} noValidate className="space-y-3">
                <label htmlFor="secDisablePw" className="text-sm text-muted-foreground">
                  {t('profile.mfaDisableConfirm')}
                </label>
                <PasswordInput
                  id="secDisablePw"
                  value={disablePassword}
                  onChange={(e) => {
                    setDisablePassword(e.target.value);
                  }}
                  aria-invalid={hasSubmittedMfa && mfaErrors.disablePassword ? true : undefined}
                  aria-describedby={
                    hasSubmittedMfa && mfaErrors.disablePassword
                      ? 'sec-disable-pw-error'
                      : undefined
                  }
                  className={
                    hasSubmittedMfa && mfaErrors.disablePassword ? 'border-destructive' : ''
                  }
                />
                {hasSubmittedMfa && mfaErrors.disablePassword && (
                  <p id="sec-disable-pw-error" className="text-sm text-destructive">
                    {mfaErrors.disablePassword}
                  </p>
                )}
                <Button
                  type="submit"
                  variant="destructive"
                  className="w-full"
                  disabled={mfaLoading}
                >
                  {mfaLoading ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      {t('profile.mfaDisabling')}
                    </>
                  ) : (
                    t('profile.mfaDisable')
                  )}
                </Button>
              </form>
            </div>
          ) : mfaSetupData == null ? (
            <form onSubmit={(e) => void handleMfaSetup(e)} noValidate className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('profile.mfaDisabled')}</p>
              <div className="space-y-2">
                <label htmlFor="secMfaMethod" className="block text-sm font-medium leading-6">
                  {t('profile.mfaSelectMethod')}
                </label>
                <Select
                  id="secMfaMethod"
                  value={selectedMfaMethod}
                  onChange={(e) => {
                    setSelectedMfaMethod(e.target.value);
                  }}
                >
                  {availableMethods.map((m) => (
                    <option key={m} value={m}>
                      {m === 'totp'
                        ? t('profile.mfaMethodTotp')
                        : m === 'email'
                          ? t('profile.mfaMethodEmail')
                          : t('profile.mfaMethodSms')}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={mfaLoading}>
                {mfaLoading ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    {t('profile.mfaSettingUp')}
                  </>
                ) : (
                  t('profile.mfaSetUp')
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleMfaConfirm(e)} noValidate className="space-y-4">
              {selectedMfaMethod === 'totp' && mfaSetupData.qrDataUri != null && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('profile.mfaScanQr')}</p>
                  <img
                    src={mfaSetupData.qrDataUri}
                    alt={t('profile.mfaQrCode')}
                    className="mx-auto"
                  />
                  {mfaSetupData.secret != null && (
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">{t('profile.mfaManualEntry')}</p>
                      <code className="block rounded bg-muted px-3 py-2 text-center text-sm">
                        {mfaSetupData.secret}
                      </code>
                    </div>
                  )}
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="secMfaCode" className="block text-sm font-medium leading-6">
                  {t('profile.mfaEnterCode')}
                </label>
                <Input
                  id="secMfaCode"
                  value={mfaCode}
                  onChange={(e) => {
                    setMfaCode(e.target.value);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-invalid={hasSubmittedMfa && mfaErrors.mfaCode ? true : undefined}
                  aria-describedby={
                    hasSubmittedMfa && mfaErrors.mfaCode ? 'sec-mfa-code-error' : undefined
                  }
                  className={hasSubmittedMfa && mfaErrors.mfaCode ? 'border-destructive' : ''}
                />
                {hasSubmittedMfa && mfaErrors.mfaCode && (
                  <p id="sec-mfa-code-error" className="text-sm text-destructive">
                    {mfaErrors.mfaCode}
                  </p>
                )}
              </div>
              <Button type="submit" className="w-full" disabled={mfaLoading}>
                {mfaLoading ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    {t('profile.mfaVerifying')}
                  </>
                ) : (
                  t('profile.mfaVerify')
                )}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
