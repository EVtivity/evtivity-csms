// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isRequiredDriverEventType } from '@evtivity/lib/notification-events';
import { EventSettingsLayout } from '@/components/EventSettingsLayout';
import {
  DriverChoiceCard,
  type MandatoryChannels,
} from '@/components/notifications/DriverChoiceCard';
import { api } from '@/lib/api';
import { useHasCompanyWidePermission, useHasPermission } from '@/lib/auth';
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
  emailMandatory?: boolean;
  smsMandatory?: boolean;
  pushMandatory?: boolean;
}

const NO_MANDATORY: MandatoryChannels = { email: false, sms: false, push: false };

export function DriverEvents(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = useHasPermission('notifications:write');
  // The mandatory setting is company-wide, as the API requires (access to every site).
  const canEditMandatory = useHasCompanyWidePermission('notifications:write');

  const { data: settings } = useQuery({
    queryKey: ['driver-event-settings'],
    queryFn: () => api.get<DriverEventSetting[]>('/v1/driver-event-settings'),
    staleTime: 60_000,
  });

  // Which channels reach drivers, for the "not configured" hint next to Mandatory.
  const { data: channels } = useQuery({
    queryKey: ['driver-event-settings', 'channels'],
    queryFn: () => api.get<MandatoryChannels>('/v1/driver-event-settings/channels'),
    staleTime: 60_000,
  });

  const enabledMap = new Map<string, boolean>();
  const mandatoryMap = new Map<string, MandatoryChannels>();
  for (const setting of settings ?? []) {
    enabledMap.set(setting.eventType, setting.isEnabled);
    mandatoryMap.set(setting.eventType, {
      email: setting.emailMandatory === true,
      sms: setting.smsMandatory === true,
      push: setting.pushMandatory === true,
    });
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
      renderEventExtra={(eventType) => (
        <DriverChoiceCard
          key={eventType}
          eventType={eventType}
          eventOn={isRequiredDriverEventType(eventType) || (enabledMap.get(eventType) ?? true)}
          mandatory={mandatoryMap.get(eventType) ?? NO_MANDATORY}
          available={channels}
          canEdit={canEditMandatory}
          onChange={async (channel, mandatory) => {
            await api.put('/v1/driver-event-settings/mandatory', {
              eventType,
              [channel]: mandatory,
            });
            await queryClient.invalidateQueries({ queryKey: ['driver-event-settings'] });
            void queryClient.invalidateQueries({ queryKey: ['audit', 'notification_template'] });
          }}
        />
      )}
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
