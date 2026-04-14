// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

export function AccountPersonalInfo(): React.JSX.Element {
  const { t } = useTranslation();
  const driver = useAuth((s) => s.driver);
  const hydrate = useAuth((s) => s.hydrate);

  const [firstName, setFirstName] = useState(driver?.firstName ?? '');
  const [lastName, setLastName] = useState(driver?.lastName ?? '');
  const [phone, setPhone] = useState(driver?.phone ?? '');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

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
      <Button type="submit" className="w-full" disabled={profileLoading}>
        {profileLoading ? t('common.saving') : t('common.save')}
      </Button>
    </form>
  );
}
