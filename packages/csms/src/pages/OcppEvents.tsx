// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { EventSettingsLayout } from '@/components/EventSettingsLayout';
import { api } from '@/lib/api';
import { OCPP_COMMON_EVENTS, OCPP_21_EVENTS } from '@/lib/template-variables';

const CHANNELS = ['email', 'webhook'] as const;

interface OcppEventSetting {
  id: number;
  eventType: string;
  recipient: string;
  channel: string;
  templateHtml: string | null;
  language: string | null;
}

export function OcppEvents(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [recipient, setRecipient] = useState('');
  const [recipientLoadedKey, setRecipientLoadedKey] = useState('');

  const { data: eventSettings } = useQuery({
    queryKey: ['ocpp-event-settings'],
    queryFn: () => api.get<OcppEventSetting[]>('/v1/ocpp-event-settings'),
  });

  // Key by "eventType:channel" for per-channel enabled state and recipient lookup
  const enabledMap = new Map<string, boolean>();
  const recipientMap = new Map<string, string>();
  if (eventSettings != null) {
    for (const s of eventSettings) {
      const key = `${s.eventType}:${s.channel}`;
      enabledMap.set(key, true);
      recipientMap.set(key, s.recipient);
    }
  }

  return (
    <EventSettingsLayout
      sidebarTitle={t('notifications.ocppEvents')}
      emptyMessage={t('notifications.selectOcppEvent')}
      sections={[
        { title: t('notifications.ocppCommonEvents'), events: OCPP_COMMON_EVENTS },
        { title: t('notifications.ocpp21Events'), events: OCPP_21_EVENTS },
      ]}
      channels={CHANNELS}
      toggleEndpoint="/v1/ocpp-event-settings"
      toggleQueryKey={['ocpp-event-settings']}
      enabledMap={enabledMap}
      defaultEnabled={false}
      renderSettingsExtra={({ selectedEvent, channel, markDirty }) => {
        const settingKey = `${selectedEvent}:${channel}`;
        // Sync recipient from DB when event/channel selection changes
        if (settingKey !== recipientLoadedKey && eventSettings != null) {
          setRecipient(recipientMap.get(settingKey) ?? '');
          setRecipientLoadedKey(settingKey);
        }

        return (
          <div className="space-y-2">
            <Label htmlFor="ocpp-event-recipient">
              {channel === 'webhook'
                ? t('notifications.webhookUrlLabel')
                : t('notifications.recipientLabel')}
            </Label>
            <Input
              id="ocpp-event-recipient"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                markDirty();
              }}
              placeholder={
                channel === 'webhook'
                  ? 'https://example.com/webhook'
                  : t('notifications.recipientPlaceholder')
              }
            />
          </div>
        );
      }}
      onSave={async ({ eventType, channel, language }) => {
        if (recipient.trim() === '') {
          throw new Error(
            channel === 'webhook'
              ? t('notifications.webhookUrlRequired')
              : t('notifications.recipientRequired'),
          );
        }
        await api.put('/v1/ocpp-event-settings', {
          eventType,
          recipient,
          channel,
          language,
        });
        void queryClient.invalidateQueries({ queryKey: ['ocpp-event-settings'] });
      }}
    />
  );
}
