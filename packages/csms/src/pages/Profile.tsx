// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ProfilePersonalInfo } from '@/components/profile/ProfilePersonalInfo';
import { ProfileAppearance } from '@/components/profile/ProfileAppearance';
import { ProfilePassword } from '@/components/profile/ProfilePassword';
import { ProfileMfa } from '@/components/profile/ProfileMfa';
import { ProfileNotifications } from '@/components/profile/ProfileNotifications';
import { ProfileChatbotAi } from '@/components/profile/ProfileChatbotAi';
import { ProfileSupportAi } from '@/components/profile/ProfileSupportAi';
import { api } from '@/lib/api';

interface SettingValue {
  value: unknown;
}

export interface UserMe {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  roleId: string;
  isActive: boolean;
  language: string;
  timezone: string;
  lastLoginAt: string | null;
  createdAt: string;
  role: { id: string; name: string } | null;
}

export function Profile(): React.JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useTab('personal');

  const { data: user, isLoading } = useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => api.get<UserMe>('/v1/users/me'),
  });

  const { data: chatbotAiSetting } = useQuery({
    queryKey: ['settings', 'chatbotAi.enabled'],
    queryFn: () => api.get<SettingValue>('/v1/settings/chatbotAi.enabled'),
  });
  const { data: supportAiSetting } = useQuery({
    queryKey: ['settings', 'supportAi.enabled'],
    queryFn: () => api.get<SettingValue>('/v1/settings/supportAi.enabled'),
  });

  const chatbotAiEnabled = chatbotAiSetting?.value === true || chatbotAiSetting?.value === 'true';
  const supportAiEnabled = supportAiSetting?.value === true || supportAiSetting?.value === 'true';

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (user == null) {
    return <p className="text-destructive">{t('profile.userNotFound')}</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('profile.title')}</h1>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="personal">{t('profile.personalInfo')}</TabsTrigger>
          <TabsTrigger value="appearance">{t('profile.appearance')}</TabsTrigger>
          <TabsTrigger value="password">{t('profile.changePassword')}</TabsTrigger>
          <TabsTrigger value="mfa">{t('profile.mfaSecurity')}</TabsTrigger>
          <TabsTrigger value="notifications">{t('profile.notifications')}</TabsTrigger>
          {chatbotAiEnabled && (
            <TabsTrigger value="chatbotAi">{t('profile.chatbotAi')}</TabsTrigger>
          )}
          {supportAiEnabled && (
            <TabsTrigger value="supportAi">{t('profile.supportAi')}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="personal">
          <ProfilePersonalInfo user={user} />
        </TabsContent>
        <TabsContent value="appearance">
          <ProfileAppearance />
        </TabsContent>
        <TabsContent value="password">
          <ProfilePassword />
        </TabsContent>
        <TabsContent value="mfa">
          <ProfileMfa />
        </TabsContent>
        <TabsContent value="notifications">
          <ProfileNotifications />
        </TabsContent>
        {chatbotAiEnabled && (
          <TabsContent value="chatbotAi">
            <ProfileChatbotAi />
          </TabsContent>
        )}
        {supportAiEnabled && (
          <TabsContent value="supportAi">
            <ProfileSupportAi />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
