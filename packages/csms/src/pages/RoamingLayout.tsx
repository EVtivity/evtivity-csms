// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TABS = [
  { value: 'partners', path: '/roaming/partners', labelKey: 'nav.roamingPartners' as const },
  { value: 'locations', path: '/roaming/locations', labelKey: 'nav.roamingLocations' as const },
  { value: 'sessions', path: '/roaming/sessions', labelKey: 'nav.roamingSessions' as const },
  { value: 'cdrs', path: '/roaming/cdrs', labelKey: 'nav.roamingCdrs' as const },
  { value: 'tariffs', path: '/roaming/tariffs', labelKey: 'nav.roamingTariffs' as const },
];

export function RoamingLayout(): React.JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const activeTab = TABS.find((tab) => location.pathname.startsWith(tab.path))?.value ?? 'partners';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('nav.roaming')}</h1>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const tab = TABS.find((tab) => tab.value === value);
          if (tab != null) void navigate(tab.path);
        }}
      >
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
