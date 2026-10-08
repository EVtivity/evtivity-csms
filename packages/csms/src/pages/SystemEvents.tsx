// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { EventSettingsLayout } from '@/components/EventSettingsLayout';
import {
  OPERATOR_ACCOUNT_EVENTS,
  OPERATOR_SUPPORT_EVENTS,
  OPERATOR_SESSION_EVENTS,
  SITE_HOST_EVENTS,
  FLEET_BILLING_SYSTEM_EVENTS,
  FLEET_INVOICE_EVENTS,
} from '@/lib/template-variables';

const CHANNELS = ['email', 'sms'] as const;

export function SystemEvents(): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <EventSettingsLayout
      sidebarTitle={t('notifications.systemEventTypes')}
      emptyMessage={t('notifications.selectSystemEvent')}
      sections={[
        { title: t('notifications.operatorEvents'), events: OPERATOR_ACCOUNT_EVENTS },
        { title: t('notifications.supportEvents'), events: OPERATOR_SUPPORT_EVENTS },
        { title: t('notifications.sessionAlertEvents'), events: OPERATOR_SESSION_EVENTS },
        { title: t('notifications.siteHostEvents'), events: SITE_HOST_EVENTS },
        { title: t('notifications.fleetBillingAlertEvents'), events: FLEET_BILLING_SYSTEM_EVENTS },
        { title: t('notifications.fleetInvoiceEvents'), events: FLEET_INVOICE_EVENTS },
      ]}
      channels={CHANNELS}
      channelTooltip={t('notifications.channelTooltipSystem')}
    />
  );
}
