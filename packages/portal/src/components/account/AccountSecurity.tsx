// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';

export function AccountSecurity(): React.JSX.Element {
  const { t } = useTranslation();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

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

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handlePasswordChange(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPasswordMsg('');
    setPasswordLoading(true);
    try {
      await api.patch('/v1/portal/driver/password', { currentPassword, newPassword });
      setPasswordMsg(t('profile.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
    } catch {
      setPasswordMsg(t('profile.passwordChangeFailed'));
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
    } catch {
      setMfaMsg(t('profile.mfaSetupFailed'));
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
    } catch {
      setMfaMsg(t('profile.mfaVerifyFailed'));
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
    } catch {
      setMfaMsg(t('profile.mfaDisableFailed'));
    } finally {
      setMfaLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Password change */}
      <form onSubmit={(e) => void handlePasswordChange(e)} className="space-y-4">
        <h3 className="text-sm font-semibold">{t('profile.changePassword')}</h3>
        {passwordMsg !== '' && <p className="text-sm text-muted-foreground">{passwordMsg}</p>}
        <div className="space-y-2">
          <label htmlFor="secCurrentPw" className="text-sm font-medium">
            {t('profile.currentPassword')}
          </label>
          <PasswordInput
            id="secCurrentPw"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
            }}
            required
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="secNewPw" className="text-sm font-medium">
            {t('profile.newPassword')}
          </label>
          <PasswordInput
            id="secNewPw"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
            }}
            required
            minLength={8}
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
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                <label htmlFor="secMfaMethod" className="text-sm font-medium">
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                  <img src={mfaSetupData.qrDataUri} alt="QR Code" className="mx-auto" />
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
                <label htmlFor="secMfaCode" className="text-sm font-medium">
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
