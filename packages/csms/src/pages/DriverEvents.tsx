// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { EventSettingsLayout } from '@/components/EventSettingsLayout';
import {
  DRIVER_SESSION_EVENTS,
  DRIVER_ACCOUNT_EVENTS,
  DRIVER_PAYMENT_EVENTS,
  DRIVER_RESERVATION_EVENTS,
  DRIVER_SUPPORT_EVENTS,
  DRIVER_MFA_EVENTS,
} from '@/lib/template-variables';

const CHANNELS = ['email', 'sms'] as const;

export function DriverEvents(): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <EventSettingsLayout
      sidebarTitle={t('notifications.driverEventTypes')}
      emptyMessage={t('notifications.noDriverEvents')}
      sections={[
        { title: t('notifications.sessionEvents'), events: DRIVER_SESSION_EVENTS },
        { title: t('notifications.driverAccountEvents'), events: DRIVER_ACCOUNT_EVENTS },
        { title: t('notifications.paymentEvents'), events: DRIVER_PAYMENT_EVENTS },
        { title: t('notifications.reservationEvents'), events: DRIVER_RESERVATION_EVENTS },
        { title: t('notifications.supportEvents'), events: DRIVER_SUPPORT_EVENTS },
        { title: t('notifications.mfaEvents'), events: DRIVER_MFA_EVENTS },
      ]}
      channels={CHANNELS}
      channelTooltip={t('notifications.channelTooltipDriver')}
    />
  );
}
