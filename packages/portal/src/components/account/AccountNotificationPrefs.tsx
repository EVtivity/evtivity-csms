// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

export function AccountNotificationPrefs(): React.JSX.Element {
  const { t } = useTranslation();

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(true);
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
      setMsgType('success');
      setMsg(t('profile.preferencesSaved'));
    } catch (err) {
      setMsgType('error');
      setMsg(getErrorMessage(err, t, 'profile.preferencesFailed'));
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
        <Checkbox
          id="notifEmail"
          checked={emailEnabled}
          onChange={(e) => {
            setEmailEnabled(e.target.checked);
          }}
        />
        <label htmlFor="notifEmail" className="text-sm font-medium">
          {t('profile.emailNotifications')}
        </label>
      </div>
      <div className="flex items-center space-x-2">
        <Checkbox
          id="notifSms"
          checked={smsEnabled}
          onChange={(e) => {
            setSmsEnabled(e.target.checked);
          }}
        />
        <label htmlFor="notifSms" className="text-sm font-medium">
          {t('profile.smsNotifications')}
        </label>
      </div>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t('common.saving') : t('common.save')}
      </Button>
    </form>
  );
}
