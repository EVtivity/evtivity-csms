// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { OcppEvents } from '@/pages/OcppEvents';
import { DriverEvents } from '@/pages/DriverEvents';
import { SystemEvents } from '@/pages/SystemEvents';
import { NotificationHistory } from '@/pages/NotificationHistory';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';

export function NotificationRules(): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useTab('driver-events');
  // The notification log is company-wide: the API answers 404 to a site-restricted user.
  const hasAllSiteAccess = useHasAllSiteAccess();
  const canReadAudit = useHasPermission('audit:read');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{t('notifications.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notifications.subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="driver-events">{t('notifications.driverEventsTab')}</TabsTrigger>
          <TabsTrigger value="system-events">{t('notifications.systemEventsTab')}</TabsTrigger>
          <TabsTrigger value="ocpp-events">{t('notifications.ocppEventsTab')}</TabsTrigger>
          {hasAllSiteAccess && (
            <TabsTrigger value="sent">{t('notifications.sentNotificationsTab')}</TabsTrigger>
          )}
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
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

        {hasAllSiteAccess && (
          <TabsContent value="sent">
            <NotificationHistory />
          </TabsContent>
        )}

        {canReadAudit && (
          <TabsContent value="history">
            {/* Notification template changes, every event type. */}
            <EntityHistoryTab
              entityType="notification_template"
              entityId={null}
              extraColumns={[
                {
                  header: t('notifications.eventType'),
                  className: 'text-sm font-medium',
                  render: (row) => {
                    const key = (row.after ?? row.before) as {
                      channel?: string;
                      language?: string;
                    } | null;
                    const detail = [key?.channel, key?.language].filter((v) => v != null);
                    return detail.length > 0
                      ? `${row.entityIdSnapshot} (${detail.join(', ')})`
                      : row.entityIdSnapshot;
                  },
                },
              ]}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
