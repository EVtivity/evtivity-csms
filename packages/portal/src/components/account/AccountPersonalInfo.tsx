// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LANGUAGES } from '@/components/ui/language-select';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { TIMEZONE_OPTIONS } from '@/lib/timezone';

export function AccountPersonalInfo(): React.JSX.Element {
  const { t } = useTranslation();
  const driver = useAuth((s) => s.driver);
  const hydrate = useAuth((s) => s.hydrate);
  const applyLanguageLocal = useAuth((s) => s.applyLanguageLocal);
  const applyTimezoneLocal = useAuth((s) => s.applyTimezoneLocal);
  const applyThemeLocal = useAuth((s) => s.applyThemeLocal);
  const applyDistanceUnitLocal = useAuth((s) => s.applyDistanceUnitLocal);
  const authTheme = useAuth((s) => s.theme);

  const [firstName, setFirstName] = useState(driver?.firstName ?? '');
  const [lastName, setLastName] = useState(driver?.lastName ?? '');
  const [phone, setPhone] = useState(driver?.phone ?? '');
  const [selectedLanguage, setSelectedLanguage] = useState(driver?.language ?? 'en');
  const [selectedTimezone, setSelectedTimezone] = useState(driver?.timezone ?? 'America/New_York');
  const [selectedTheme, setSelectedTheme] = useState<'light' | 'dark'>(authTheme);
  const [selectedDistanceUnit, setSelectedDistanceUnit] = useState<'miles' | 'km'>(
    driver?.distanceUnit ?? 'miles',
  );
  const [profileMsg, setProfileMsg] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleProfileUpdate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setProfileMsg('');
    setProfileLoading(true);
    try {
      // Single PATCH persists everything; local-only Zustand updates run the
      // client-side side effects (i18n bundle load, theme class swap) without
      // additional round-trips.
      await api.patch('/v1/portal/driver/profile', {
        firstName,
        lastName,
        phone,
        language: selectedLanguage,
        timezone: selectedTimezone,
        themePreference: selectedTheme,
        distanceUnit: selectedDistanceUnit,
      });
      if (selectedLanguage !== driver?.language) {
        await applyLanguageLocal(selectedLanguage);
      }
      if (selectedTimezone !== driver?.timezone) {
        applyTimezoneLocal(selectedTimezone);
      }
      if (selectedTheme !== authTheme) {
        applyThemeLocal(selectedTheme);
      }
      if (selectedDistanceUnit !== driver?.distanceUnit) {
        applyDistanceUnitLocal(selectedDistanceUnit);
      }
      hydrate();
      setProfileMsg(t('profile.profileUpdated'));
    } catch {
      setProfileMsg(t('profile.profileUpdateFailed'));
    } finally {
      setProfileLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleProfileUpdate(e)} className="space-y-4">
      {profileMsg !== '' && <p className="text-sm text-muted-foreground">{profileMsg}</p>}
      <div className="space-y-2">
        <label htmlFor="acctEmail" className="text-sm font-medium">
          {t('profile.email')}
        </label>
        <Input id="acctEmail" value={driver?.email ?? ''} disabled />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <label htmlFor="acctFirst" className="text-sm font-medium">
            {t('profile.firstName')}
          </label>
          <Input
            id="acctFirst"
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
            }}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="acctLast" className="text-sm font-medium">
            {t('profile.lastName')}
          </label>
          <Input
            id="acctLast"
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
            }}
          />
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="acctPhone" className="text-sm font-medium">
          {t('profile.phone')}
        </label>
        <Input
          id="acctPhone"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
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

      <Button type="submit" className="w-full" disabled={profileLoading}>
        {profileLoading ? t('common.saving') : t('common.save')}
      </Button>
    </form>
  );
}
