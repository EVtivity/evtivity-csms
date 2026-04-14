// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EmailLogTab } from '@/components/notifications/EmailLogTab';
import { SmsLogTab } from '@/components/notifications/SmsLogTab';
import { PushLogTab } from '@/components/notifications/PushLogTab';

export function NotificationHistory(): React.JSX.Element {
  const { t } = useTranslation();
  const [channelTab, setChannelTab] = useTab('email', 'channel');

  return (
    <div className="space-y-4">
      <Tabs value={channelTab} onValueChange={setChannelTab}>
        <TabsList>
          <TabsTrigger value="email">{t('notifications.emailTab')}</TabsTrigger>
          <TabsTrigger value="sms">{t('notifications.smsTab')}</TabsTrigger>
          <TabsTrigger value="push">{t('notifications.pushTab')}</TabsTrigger>
        </TabsList>

        <TabsContent value="email">
          <EmailLogTab />
        </TabsContent>

        <TabsContent value="sms">
          <SmsLogTab />
        </TabsContent>

        <TabsContent value="push">
          <PushLogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
