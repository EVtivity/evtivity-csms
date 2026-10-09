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
import { PasswordRequirements } from '@/components/PasswordRequirements';

export function AccountSecurity(): React.JSX.Element {
  const { t, i18n } = useTranslation();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  // The API refused the new password (WEAK_PASSWORD). Translated at render, cleared on edit.
  const [serverWeakPassword, setServerWeakPassword] = useState(false);

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
      const rulesError = passwordRulesMessage(newPassword, t, i18n.language);
      if (rulesError != null) errors.newPassword = rulesError;
      else if (serverWeakPassword) errors.newPassword = t('errors.WEAK_PASSWORD');
    }
    return errors;
  }

  const passwordErrors = getPasswordErrors();

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
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerWeakPassword(true);
      else setPasswordMsg(getErrorMessage(err, t, 'profile.passwordChangeFailed'));
    } finally {
      setPasswordLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaSetup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
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
    setMfaMsg('');
    setMfaLoading(true);
    try {
      await api.post('/v1/portal/driver/mfa/confirm', {
        method: selectedMfaMethod,
        code: mfaCode,
        challengeId: mfaSetupData?.challengeId,
      });
      setMfaEnabled(true);
      setMfaMethod(selectedMfaMethod);
      setMfaSetupData(null);
      setMfaCode('');
    } catch (err) {
      setMfaMsg(getErrorMessage(err, t, 'profile.mfaVerifyFailed'));
    } finally {
      setMfaLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaDisable(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMfaMsg('');
    setMfaLoading(true);
    try {
      await api.delete('/v1/portal/driver/mfa', { password: disablePassword });
      setMfaEnabled(false);
      setMfaMethod(null);
      setDisablePassword('');
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
            aria-describedby="sec-password-requirements"
            onChange={(e) => {
              setNewPassword(e.target.value);
              setServerWeakPassword(false);
            }}
            className={
              hasSubmittedPassword && passwordErrors.newPassword ? 'border-destructive' : ''
            }
          />
          {hasSubmittedPassword && passwordErrors.newPassword && (
            <p className="text-sm text-destructive">{passwordErrors.newPassword}</p>
          )}
          <PasswordRequirements
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
              <form onSubmit={(e) => void handleMfaDisable(e)} className="space-y-3">
                <label htmlFor="secDisablePw" className="text-sm text-muted-foreground">
                  {t('profile.mfaDisableConfirm')}
                </label>
                <PasswordInput
                  id="secDisablePw"
                  value={disablePassword}
                  onChange={(e) => {
                    setDisablePassword(e.target.value);
                  }}
                  required
                />
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
            <form onSubmit={(e) => void handleMfaSetup(e)} className="space-y-4">
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
            <form onSubmit={(e) => void handleMfaConfirm(e)} className="space-y-4">
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
                  maxLength={6}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                />
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
