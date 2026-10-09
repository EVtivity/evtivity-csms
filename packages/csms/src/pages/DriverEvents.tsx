// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isRequiredDriverEventType } from '@evtivity/lib/notification-events';
import { EventSettingsLayout } from '@/components/EventSettingsLayout';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import {
  DRIVER_SESSION_EVENTS,
  DRIVER_ACCOUNT_EVENTS,
  DRIVER_PAYMENT_EVENTS,
  DRIVER_RESERVATION_EVENTS,
  DRIVER_INVOICE_EVENTS,
  DRIVER_SUPPORT_EVENTS,
  DRIVER_MFA_EVENTS,
  DRIVER_TOKEN_EVENTS,
  DRIVER_MAINTENANCE_EVENTS,
  DRIVER_WATCH_EVENTS,
  DRIVER_PREPAID_EVENTS,
  DRIVER_FLEET_EVENTS,
  EMAIL_ONLY_DRIVER_EVENTS,
} from '@/lib/template-variables';

const CHANNELS = ['email', 'sms'] as const;
const EMAIL_ONLY = ['email'] as const;

function channelsFor(eventType: string): readonly string[] {
  return EMAIL_ONLY_DRIVER_EVENTS.includes(eventType) ? EMAIL_ONLY : CHANNELS;
}

interface DriverEventSetting {
  eventType: string;
  isEnabled: boolean;
}

export function DriverEvents(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = useHasPermission('notifications:write');

  const { data: settings } = useQuery({
    queryKey: ['driver-event-settings'],
    queryFn: () => api.get<DriverEventSetting[]>('/v1/driver-event-settings'),
    staleTime: 60_000,
  });

  const enabledMap = new Map<string, boolean>();
  for (const setting of settings ?? []) {
    enabledMap.set(setting.eventType, setting.isEnabled);
  }

  return (
    <EventSettingsLayout
      sidebarTitle={t('notifications.driverEventTypes')}
      emptyMessage={t('notifications.noDriverEvents')}
      sections={[
        { title: t('notifications.sessionEvents'), events: DRIVER_SESSION_EVENTS },
        { title: t('notifications.driverAccountEvents'), events: DRIVER_ACCOUNT_EVENTS },
        { title: t('notifications.paymentEvents'), events: DRIVER_PAYMENT_EVENTS },
        { title: t('notifications.reservationEvents'), events: DRIVER_RESERVATION_EVENTS },
        { title: t('notifications.invoiceEvents'), events: DRIVER_INVOICE_EVENTS },
        { title: t('notifications.supportEvents'), events: DRIVER_SUPPORT_EVENTS },
        { title: t('notifications.mfaEvents'), events: DRIVER_MFA_EVENTS },
        { title: t('notifications.tokenEvents'), events: DRIVER_TOKEN_EVENTS },
        { title: t('notifications.maintenanceEvents'), events: DRIVER_MAINTENANCE_EVENTS },
        { title: t('notifications.watchEvents'), events: DRIVER_WATCH_EVENTS },
        { title: t('notifications.prepaidEvents'), events: DRIVER_PREPAID_EVENTS },
        { title: t('notifications.fleetEvents'), events: DRIVER_FLEET_EVENTS },
      ]}
      channels={CHANNELS}
      channelsFor={channelsFor}
      channelTooltip={t('notifications.channelTooltipDriver')}
      eventSwitch={{
        enabledMap,
        isRequired: isRequiredDriverEventType,
        requiredTooltip: t('notifications.requiredEventTooltip'),
        switchTooltip: t('notifications.eventSwitchTooltip'),
        canEdit,
        onChange: async (eventType, isEnabled) => {
          await api.put('/v1/driver-event-settings', { eventType, isEnabled });
          await queryClient.invalidateQueries({ queryKey: ['driver-event-settings'] });
        },
      }}
    />
  );
}
