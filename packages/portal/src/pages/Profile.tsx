// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { LANGUAGES } from '@/components/ui/language-select';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { TIMEZONE_OPTIONS } from '@/lib/timezone';

export function Profile(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const driver = useAuth((s) => s.driver);
  const logout = useAuth((s) => s.logout);
  const hydrate = useAuth((s) => s.hydrate);
  const setLanguage = useAuth((s) => s.setLanguage);
  const setTimezone = useAuth((s) => s.setTimezone);
  const setTheme = useAuth((s) => s.setTheme);
  const authTheme = useAuth((s) => s.theme);

  const [firstName, setFirstName] = useState(driver?.firstName ?? '');
  const [lastName, setLastName] = useState(driver?.lastName ?? '');
  const [phone, setPhone] = useState(driver?.phone ?? '');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [selectedLanguage, setSelectedLanguage] = useState(driver?.language ?? 'en');
  const [selectedTimezone, setSelectedTimezone] = useState(driver?.timezone ?? 'America/New_York');
  const [selectedTheme, setSelectedTheme] = useState<'light' | 'dark'>(authTheme);
  const [prefsSettingsMsg, setPrefsSettingsMsg] = useState('');
  const [prefsSettingsLoading, setPrefsSettingsLoading] = useState(false);

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [prefsMsg, setPrefsMsg] = useState('');
  const [prefsLoading, setPrefsLoading] = useState(false);

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

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleProfileUpdate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setProfileMsg('');
    setProfileLoading(true);
    try {
      await api.patch('/v1/portal/driver/profile', { firstName, lastName, phone });
      hydrate();
      setProfileMsg(t('profile.profileUpdated'));
    } catch {
      setProfileMsg(t('profile.profileUpdateFailed'));
    } finally {
      setProfileLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handlePrefsSettingsSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPrefsSettingsMsg('');
    setPrefsSettingsLoading(true);
    try {
      await setLanguage(selectedLanguage);
      await setTimezone(selectedTimezone);
      await setTheme(selectedTheme);
      setPrefsSettingsMsg(t('profile.preferencesSaved'));
    } catch {
      setPrefsSettingsMsg(t('profile.preferencesFailed'));
    } finally {
      setPrefsSettingsLoading(false);
    }
  }

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

  useEffect(() => {
    void api
      .get<{
        emailEnabled: boolean;
        smsEnabled: boolean;
      }>('/v1/portal/driver/notification-preferences')
      .then((prefs) => {
        setEmailEnabled(prefs.emailEnabled);
        setSmsEnabled(prefs.smsEnabled);
      });
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handlePrefsSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPrefsMsg('');
    setPrefsLoading(true);
    try {
      await api.put('/v1/portal/driver/notification-preferences', {
        emailEnabled,
        smsEnabled,
      });
      setPrefsMsg(t('profile.preferencesSaved'));
    } catch {
      setPrefsMsg(t('profile.preferencesFailed'));
    } finally {
      setPrefsLoading(false);
    }
  }

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

  function handleLogout(): void {
    void logout();
    void navigate('/login');
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('profile.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.personalInfo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleProfileUpdate(e)} className="space-y-4">
            {profileMsg !== '' && <p className="text-sm text-muted-foreground">{profileMsg}</p>}
            <div className="space-y-2">
              <label htmlFor="profileEmail" className="text-sm font-medium">
                {t('profile.email')}
              </label>
              <Input id="profileEmail" value={driver?.email ?? ''} disabled />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor="profileFirst" className="text-sm font-medium">
                  {t('profile.firstName')}
                </label>
                <Input
                  id="profileFirst"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="profileLast" className="text-sm font-medium">
                  {t('profile.lastName')}
                </label>
                <Input
                  id="profileLast"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="profilePhone" className="text-sm font-medium">
                {t('profile.phone')}
              </label>
              <Input
                id="profilePhone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
              />
            </div>
            <Button type="submit" className="w-full" disabled={profileLoading}>
              {profileLoading ? t('common.saving') : t('common.save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.language')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handlePrefsSettingsSave(e)} className="space-y-4">
            {prefsSettingsMsg !== '' && (
              <p className="text-sm text-muted-foreground">{prefsSettingsMsg}</p>
            )}
            <Select
              aria-label="Language"
              value={selectedLanguage}
              onChange={(e) => {
                setSelectedLanguage(e.target.value);
              }}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </Select>
            <div className="space-y-2">
              <label htmlFor="profileTimezone" className="text-sm font-medium">
                {t('profile.timezone')}
              </label>
              <Select
                id="profileTimezone"
                value={selectedTimezone}
                onChange={(e) => {
                  setSelectedTimezone(e.target.value);
                }}
              >
                {TIMEZONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="profileTheme" className="text-sm font-medium">
                {t('profile.theme')}
              </label>
              <Select
                id="profileTheme"
                value={selectedTheme}
                onChange={(e) => {
                  setSelectedTheme(e.target.value as 'light' | 'dark');
                }}
              >
                <option value="light">{t('profile.themeLight')}</option>
                <option value="dark">{t('profile.themeDark')}</option>
              </Select>
            </div>
            <Button type="submit" className="w-full" disabled={prefsSettingsLoading}>
              {prefsSettingsLoading ? t('common.saving') : t('common.save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.notificationPreferences')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handlePrefsSave(e)} className="space-y-4">
            {prefsMsg !== '' && <p className="text-sm text-muted-foreground">{prefsMsg}</p>}
            <div className="flex items-center space-x-2">
              <input
                id="emailEnabled"
                type="checkbox"
                checked={emailEnabled}
                onChange={(e) => {
                  setEmailEnabled(e.target.checked);
                }}
                className="h-4 w-4 rounded border-input"
              />
              <label htmlFor="emailEnabled" className="text-sm font-medium">
                {t('profile.emailNotifications')}
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <input
                id="smsEnabled"
                type="checkbox"
                checked={smsEnabled}
                onChange={(e) => {
                  setSmsEnabled(e.target.checked);
                }}
                className="h-4 w-4 rounded border-input"
              />
              <label htmlFor="smsEnabled" className="text-sm font-medium">
                {t('profile.smsNotifications')}
              </label>
            </div>
            <Button type="submit" className="w-full" disabled={prefsLoading}>
              {prefsLoading ? t('common.saving') : t('common.save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.changePassword')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handlePasswordChange(e)} className="space-y-4">
            {passwordMsg !== '' && <p className="text-sm text-muted-foreground">{passwordMsg}</p>}
            <div className="space-y-2">
              <label htmlFor="currentPw" className="text-sm font-medium">
                {t('profile.currentPassword')}
              </label>
              <PasswordInput
                id="currentPw"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                }}
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="newPw" className="text-sm font-medium">
                {t('profile.newPassword')}
              </label>
              <PasswordInput
                id="newPw"
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
        </CardContent>
      </Card>

      {(mfaEnabled || availableMethods.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.mfaSecurity')}</CardTitle>
          </CardHeader>
          <CardContent>
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
                  <p className="text-sm text-muted-foreground">{t('profile.mfaDisableConfirm')}</p>
                  <PasswordInput
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
                  <label htmlFor="mfaMethod" className="text-sm font-medium">
                    {t('profile.mfaSelectMethod')}
                  </label>
                  <Select
                    id="mfaMethod"
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
                        <p className="text-sm text-muted-foreground">
                          {t('profile.mfaManualEntry')}
                        </p>
                        <code className="block rounded bg-muted px-3 py-2 text-center text-sm">
                          {mfaSetupData.secret}
                        </code>
                      </div>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <label htmlFor="mfaCode" className="text-sm font-medium">
                    {t('profile.mfaEnterCode')}
                  </label>
                  <Input
                    id="mfaCode"
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
          </CardContent>
        </Card>
      )}

      <Button variant="outline" className="w-full" onClick={handleLogout}>
        <LogOut className="mr-2 h-4 w-4" />
        {t('profile.signOut')}
      </Button>
    </div>
  );
}
