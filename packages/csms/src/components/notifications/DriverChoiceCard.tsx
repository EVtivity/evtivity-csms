// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoNote } from '@/components/ui/info-note';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getErrorMessage } from '@/lib/error-message';
import {
  DRIVER_NOTIFICATION_CHANNELS,
  isDriverPreferenceEventType,
  type DriverNotificationChannel,
} from '@evtivity/lib/notification-events';

export type MandatoryChannels = Record<DriverNotificationChannel, boolean>;

const CHANNEL_KEYS = {
  email: 'notifications.driverChoice.channelEmail',
  sms: 'notifications.driverChoice.channelSms',
  push: 'notifications.driverChoice.channelPush',
} as const satisfies Record<DriverNotificationChannel, string>;

interface DriverChoiceCardProps {
  eventType: string;
  /** The operator's on/off switch of the event (layer 1). */
  eventOn: boolean;
  mandatory: MandatoryChannels;
  /** Channels the operator has configured; undefined while loading. */
  available: MandatoryChannels | undefined;
  canEdit: boolean;
  onChange: (channel: DriverNotificationChannel, mandatory: boolean) => Promise<void>;
}

/**
 * Optional or Mandatory per channel for one driver event (discussion 56), shown
 * next to the event's template on the Driver Events tab. The layers in order: an
 * event that is off is never sent; a mandatory channel is sent whatever the driver
 * chose; an optional channel follows the driver's choice. Account and security
 * notices are always sent and have no choice.
 */
export function DriverChoiceCard({
  eventType,
  eventOn,
  mandatory,
  available,
  canEdit,
  onChange,
}: DriverChoiceCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const choosable = isDriverPreferenceEventType(eventType);

  async function change(channel: DriverNotificationChannel, value: boolean): Promise<void> {
    setSaving(true);
    setError('');
    try {
      await onChange(channel, value);
    } catch (err) {
      setError(getErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="driver-choice-card">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-1 text-base">
          {t('notifications.driverChoice.title')}
          <InfoTooltip content={t('notifications.driverChoice.tooltip')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!choosable ? (
          <InfoNote>{t('notifications.driverChoice.alwaysSent')}</InfoNote>
        ) : (
          <>
            {!eventOn && <InfoNote>{t('notifications.driverChoice.eventOff')}</InfoNote>}
            <div className="grid items-start gap-4 sm:grid-cols-3">
              {DRIVER_NOTIFICATION_CHANNELS.map((channel) => {
                const label = t(CHANNEL_KEYS[channel]);
                const notConfigured = available != null && !available[channel];
                return (
                  <div key={channel} className="space-y-2">
                    <Label htmlFor={`driver-choice-${channel}`} className="leading-6">
                      {label}
                    </Label>
                    <Select
                      id={`driver-choice-${channel}`}
                      aria-label={t('notifications.driverChoice.selectLabel', {
                        channel: label,
                        event: eventType,
                      })}
                      value={mandatory[channel] ? 'mandatory' : 'optional'}
                      disabled={!canEdit || saving}
                      onChange={(e) => {
                        void change(channel, e.target.value === 'mandatory');
                      }}
                    >
                      <option value="optional">{t('notifications.driverChoice.optional')}</option>
                      <option value="mandatory">{t('notifications.driverChoice.mandatory')}</option>
                    </Select>
                    {notConfigured && (
                      <p className="text-xs text-muted-foreground">
                        {t('notifications.driverChoice.notConfigured')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('notifications.driverChoice.explanation')}
            </p>
          </>
        )}
        {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
