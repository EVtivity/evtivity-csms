// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useQrIcon } from '@/hooks/use-qr-icon';
import { useAuth } from '@/lib/auth';
import { CompanySettings } from '@/components/settings/CompanySettings';
import { MarketingSettings } from '@/components/settings/MarketingSettings';
import { ContentSettings } from '@/components/settings/ContentSettings';
import { NotificationSettings } from '@/components/settings/NotificationSettings';
import { SustainabilitySettings } from '@/components/settings/SustainabilitySettings';
import { PaymentSettings } from '@/components/settings/PaymentSettings';
import { IntegrationsSettings } from '@/components/settings/IntegrationsSettings';
import { SecurityRecaptchaSettings } from '@/components/settings/SecurityRecaptchaSettings';
import { SecurityMfaSettings } from '@/components/settings/SecurityMfaSettings';
import { SecuritySsoSettings } from '@/components/settings/SecuritySsoSettings';
import { ApiKeysSettings } from '@/components/settings/ApiKeysSettings';
import { AiSettings } from '@/components/settings/AiSettings';
import { FirmwareCampaigns } from '@/pages/FirmwareCampaigns';
import { ConfigTemplates } from '@/pages/ConfigTemplates';
import { SmartChargingTemplates } from '@/pages/SmartChargingTemplates';
import { Conformance } from '@/pages/Conformance';

/** Maps tab value -> required permission */
const TAB_PERMISSIONS: Record<string, string> = {
  company: 'settings.system:read',
  marketing: 'settings.system:read',
  content: 'settings.system:read',
  notification: 'settings.notification:read',
  sustainability: 'settings.system:read',
  payment: 'settings.payment:read',
  integrations: 'settings.integrations:read',
  security: 'settings.security:read',
  apiKeys: 'settings.apiKeys:read',
  firmware: 'settings.firmware:read',
  configuration: 'settings.stationConfig:read',
  'smart-charging': 'settings.smartCharging:read',
  ai: 'settings.ai:read',
  conformance: 'settings.conformance:read',
};

function hasPerm(userPermissions: string[], required: string): boolean {
  if (userPermissions.includes(required)) return true;
  if (required.endsWith(':read')) {
    const writeVersion = required.replace(':read', ':write');
    if (userPermissions.includes(writeVersion)) return true;
  }
  return false;
}

export function Settings(): React.JSX.Element {
  const { t } = useTranslation();
  const permissions = useAuth((s) => s.permissions);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });

  const { data: securitySettings } = useQuery({
    queryKey: ['security-settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/security/settings'),
  });

  const { svgDataUri } = useQrIcon();

  const hasIcon = settings != null && typeof settings['qr_code_icon'] === 'string';

  const visibleTabs = useMemo(() => {
    return Object.entries(TAB_PERMISSIONS)
      .filter(([, perm]) => hasPerm(permissions, perm))
      .map(([tab]) => tab);
  }, [permissions]);

  const [securitySubTab, setSecuritySubTab] = useTab('recaptcha', 'sub');

  const defaultTab = visibleTabs[0] ?? 'company';
  const [activeTab, setActiveTab] = useTab(defaultTab, 'tab', ['sub']);

  const tabVisible = (tab: string): boolean => visibleTabs.includes(tab);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('settings.title')}</h1>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          {tabVisible('company') && (
            <TabsTrigger value="company">{t('settings.companyInfo')}</TabsTrigger>
          )}
          {tabVisible('marketing') && (
            <TabsTrigger value="marketing">{t('settings.marketing')}</TabsTrigger>
          )}
          {tabVisible('content') && (
            <TabsTrigger value="content">{t('settings.content')}</TabsTrigger>
          )}
          {tabVisible('notification') && (
            <TabsTrigger value="notification">{t('settings.notification')}</TabsTrigger>
          )}
          {tabVisible('sustainability') && (
            <TabsTrigger value="sustainability">{t('settings.sustainability')}</TabsTrigger>
          )}
          {tabVisible('payment') && (
            <TabsTrigger value="payment">{t('settings.payment')}</TabsTrigger>
          )}
          {tabVisible('integrations') && (
            <TabsTrigger value="integrations">{t('settings.integrations')}</TabsTrigger>
          )}
          {tabVisible('security') && (
            <TabsTrigger value="security">{t('settings.security')}</TabsTrigger>
          )}
          {tabVisible('apiKeys') && (
            <TabsTrigger value="apiKeys">{t('settings.apiKeys')}</TabsTrigger>
          )}
          {tabVisible('firmware') && (
            <TabsTrigger value="firmware">{t('settings.firmware')}</TabsTrigger>
          )}
          {tabVisible('configuration') && (
            <TabsTrigger value="configuration">{t('settings.stationConfigurations')}</TabsTrigger>
          )}
          {tabVisible('smart-charging') && (
            <TabsTrigger value="smart-charging">{t('settings.smartCharging')}</TabsTrigger>
          )}
          {tabVisible('ai') && <TabsTrigger value="ai">{t('settings.chatbotAi')}</TabsTrigger>}
          {tabVisible('conformance') && (
            <TabsTrigger value="conformance">{t('settings.conformance')}</TabsTrigger>
          )}
        </TabsList>

        {tabVisible('company') && (
          <TabsContent value="company">
            <CompanySettings settings={settings} svgDataUri={svgDataUri} hasIcon={hasIcon} />
          </TabsContent>
        )}

        {tabVisible('marketing') && (
          <TabsContent value="marketing">
            <MarketingSettings settings={settings} />
          </TabsContent>
        )}

        {tabVisible('content') && (
          <TabsContent value="content">
            <ContentSettings />
          </TabsContent>
        )}

        {tabVisible('notification') && (
          <TabsContent value="notification">
            <NotificationSettings settings={settings} />
          </TabsContent>
        )}

        {tabVisible('sustainability') && (
          <TabsContent value="sustainability">
            <SustainabilitySettings settings={settings} />
          </TabsContent>
        )}

        {tabVisible('payment') && (
          <TabsContent value="payment">
            <PaymentSettings settings={settings} />
          </TabsContent>
        )}

        {tabVisible('integrations') && (
          <TabsContent value="integrations">
            <IntegrationsSettings settings={settings} />
          </TabsContent>
        )}

        {tabVisible('security') && (
          <TabsContent value="security">
            <Tabs value={securitySubTab} onValueChange={setSecuritySubTab}>
              <TabsList>
                <TabsTrigger value="recaptcha">{t('settings.recaptcha')}</TabsTrigger>
                <TabsTrigger value="mfa">{t('settings.mfa')}</TabsTrigger>
                <TabsTrigger value="sso">{t('settings.sso')}</TabsTrigger>
              </TabsList>
              <TabsContent value="recaptcha" className="mt-4">
                <SecurityRecaptchaSettings settings={securitySettings} />
              </TabsContent>
              <TabsContent value="mfa" className="mt-4">
                <SecurityMfaSettings settings={securitySettings} />
              </TabsContent>
              <TabsContent value="sso" className="mt-4">
                <SecuritySsoSettings settings={securitySettings} />
              </TabsContent>
            </Tabs>
          </TabsContent>
        )}

        {tabVisible('apiKeys') && (
          <TabsContent value="apiKeys">
            <ApiKeysSettings />
          </TabsContent>
        )}

        {tabVisible('firmware') && (
          <TabsContent value="firmware">
            <FirmwareCampaigns embedded />
          </TabsContent>
        )}

        {tabVisible('configuration') && (
          <TabsContent value="configuration">
            <ConfigTemplates embedded />
          </TabsContent>
        )}

        {tabVisible('smart-charging') && (
          <TabsContent value="smart-charging">
            <SmartChargingTemplates embedded />
          </TabsContent>
        )}

        {tabVisible('ai') && (
          <TabsContent value="ai">
            <AiSettings settings={settings} />
          </TabsContent>
        )}

        {tabVisible('conformance') && (
          <TabsContent value="conformance">
            <Conformance embedded />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
