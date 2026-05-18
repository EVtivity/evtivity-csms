// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TABS = [
  { value: 'partners', path: '/roaming/partners', labelKey: 'nav.roamingPartners' as const },
  { value: 'locations', path: '/roaming/locations', labelKey: 'nav.roamingLocations' as const },
  { value: 'sessions', path: '/roaming/sessions', labelKey: 'nav.roamingSessions' as const },
  { value: 'cdrs', path: '/roaming/cdrs', labelKey: 'nav.roamingCdrs' as const },
  { value: 'tariffs', path: '/roaming/tariffs', labelKey: 'nav.roamingTariffs' as const },
  { value: 'history', path: '/roaming/history', labelKey: 'audit.history' as const },
];

interface RoamingOutletContext {
  setTabAction: (node: React.ReactNode) => void;
}

export function useRoamingTabAction(node: React.ReactNode): void {
  const { setTabAction } = useOutletContext<RoamingOutletContext>();
  useEffect(() => {
    setTabAction(node);
    return () => {
      setTabAction(null);
    };
  }, [node, setTabAction]);
}

export function RoamingLayout(): React.JSX.Element {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [tabAction, setTabAction] = useState<React.ReactNode>(null);

  const activeTab = TABS.find((tab) => location.pathname.startsWith(tab.path))?.value ?? 'partners';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('nav.roaming')}</h1>
        <p className="text-sm text-muted-foreground">{t('roaming.subtitle')}</p>
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const tab = TABS.find((tab) => tab.value === value);
          if (tab != null) void navigate(tab.path);
        }}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
          <div className="overflow-x-auto">
            <TabsList>
              {TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {t(tab.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {tabAction != null && (
            <div className="flex [&>*]:w-full md:shrink-0 md:[&>*]:w-auto">{tabAction}</div>
          )}
        </div>
      </Tabs>
      <div className="mt-2">
        <Outlet context={{ setTabAction } satisfies RoamingOutletContext} />
      </div>
    </div>
  );
}
