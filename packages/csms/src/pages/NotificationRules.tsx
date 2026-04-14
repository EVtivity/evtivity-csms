// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { OcppEvents } from '@/pages/OcppEvents';
import { DriverEvents } from '@/pages/DriverEvents';
import { SystemEvents } from '@/pages/SystemEvents';
import { NotificationHistory } from '@/pages/NotificationHistory';

export function NotificationRules(): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useTab('driver-events');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('notifications.title')}</h1>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="driver-events">{t('notifications.driverEventsTab')}</TabsTrigger>
          <TabsTrigger value="system-events">{t('notifications.systemEventsTab')}</TabsTrigger>
          <TabsTrigger value="ocpp-events">{t('notifications.ocppEventsTab')}</TabsTrigger>
          <TabsTrigger value="history">{t('notifications.historyTab')}</TabsTrigger>
        </TabsList>

        <TabsContent value="ocpp-events">
          <OcppEvents />
        </TabsContent>

        <TabsContent value="driver-events">
          <DriverEvents />
        </TabsContent>

        <TabsContent value="system-events">
          <SystemEvents />
        </TabsContent>

        <TabsContent value="history">
          <NotificationHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}
