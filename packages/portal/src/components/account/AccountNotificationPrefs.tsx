// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { LANGUAGES } from '@/components/ui/language-select';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TIMEZONE_OPTIONS } from '@/lib/timezone';

export function AccountNotificationPrefs(): React.JSX.Element {
  const { t } = useTranslation();
  const driver = useAuth((s) => s.driver);
  const setLanguage = useAuth((s) => s.setLanguage);
  const setTimezone = useAuth((s) => s.setTimezone);
  const setTheme = useAuth((s) => s.setTheme);
  const setDistanceUnit = useAuth((s) => s.setDistanceUnit);
  const authTheme = useAuth((s) => s.theme);

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [selectedLanguage, setSelectedLanguage] = useState(driver?.language ?? 'en');
  const [selectedTimezone, setSelectedTimezone] = useState(driver?.timezone ?? 'America/New_York');
  const [selectedTheme, setSelectedTheme] = useState<'light' | 'dark'>(authTheme);
  const [selectedDistanceUnit, setSelectedDistanceUnit] = useState<'miles' | 'km'>(
    driver?.distanceUnit ?? 'miles',
  );
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error'>('error');
  const [loading, setLoading] = useState(false);

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
  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMsg('');
    setLoading(true);
    try {
      await api.put('/v1/portal/driver/notification-preferences', { emailEnabled, smsEnabled });
      await setLanguage(selectedLanguage);
      await setTimezone(selectedTimezone);
      await setTheme(selectedTheme);
      await setDistanceUnit(selectedDistanceUnit);
      setMsgType('success');
      setMsg(t('profile.preferencesSaved'));
    } catch {
      setMsgType('error');
      setMsg(t('profile.preferencesFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
      {msg !== '' && (
        <p className={`text-sm ${msgType === 'success' ? 'text-success' : 'text-destructive'}`}>
          {msg}
        </p>
      )}
      <div className="flex items-center space-x-2">
        <input
          id="notifEmail"
          type="checkbox"
          checked={emailEnabled}
          onChange={(e) => {
            setEmailEnabled(e.target.checked);
          }}
          className="h-4 w-4 rounded border-input"
        />
        <label htmlFor="notifEmail" className="text-sm font-medium">
          {t('profile.emailNotifications')}
        </label>
      </div>
      <div className="flex items-center space-x-2">
        <input
          id="notifSms"
          type="checkbox"
          checked={smsEnabled}
          onChange={(e) => {
            setSmsEnabled(e.target.checked);
          }}
          className="h-4 w-4 rounded border-input"
        />
        <label htmlFor="notifSms" className="text-sm font-medium">
          {t('profile.smsNotifications')}
        </label>
      </div>

      <hr className="border-border" />

      <div className="space-y-2">
        <label htmlFor="acctLang" className="text-sm font-medium">
          {t('profile.language')}
        </label>
        <Select
          id="acctLang"
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
      </div>
      <div className="space-y-2">
        <label htmlFor="acctTz" className="text-sm font-medium">
          {t('profile.timezone')}
        </label>
        <Select
          id="acctTz"
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
        <label htmlFor="acctTheme" className="text-sm font-medium">
          {t('profile.theme')}
        </label>
        <Select
          id="acctTheme"
          value={selectedTheme}
          onChange={(e) => {
            setSelectedTheme(e.target.value as 'light' | 'dark');
          }}
        >
          <option value="light">{t('profile.themeLight')}</option>
          <option value="dark">{t('profile.themeDark')}</option>
        </Select>
      </div>
      <div className="space-y-2">
        <label htmlFor="acctDistance" className="text-sm font-medium">
          {t('profile.distanceUnit')}
        </label>
        <Select
          id="acctDistance"
          value={selectedDistanceUnit}
          onChange={(e) => {
            setSelectedDistanceUnit(e.target.value as 'miles' | 'km');
          }}
        >
          <option value="miles">{t('profile.distanceMiles')}</option>
          <option value="km">{t('profile.distanceKm')}</option>
        </Select>
      </div>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t('common.saving') : t('common.save')}
      </Button>
    </form>
  );
}
