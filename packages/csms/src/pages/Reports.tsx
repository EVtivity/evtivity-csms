// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { GenerateTab } from '@/components/reports/GenerateTab';
import { HistoryTab } from '@/components/reports/HistoryTab';
import { SchedulesTab } from '@/components/reports/SchedulesTab';
import { NeviComplianceTab } from '@/components/reports/NeviComplianceTab';
import { SustainabilityTab } from '@/components/reports/SustainabilityTab';

export function Reports(): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useTab('generate');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('reports.title')}</h1>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="generate">{t('reports.generateTab')}</TabsTrigger>
          <TabsTrigger value="schedules">{t('reports.schedulesTab')}</TabsTrigger>
          <TabsTrigger value="sustainability">{t('nav.sustainability')}</TabsTrigger>
          <TabsTrigger value="nevi">{t('nevi.title')}</TabsTrigger>
          <TabsTrigger value="history">{t('reports.historyTab')}</TabsTrigger>
        </TabsList>

        <TabsContent value="generate">
          <GenerateTab
            onGenerated={() => {
              setTab('history');
            }}
          />
        </TabsContent>

        <TabsContent value="history">
          <HistoryTab />
        </TabsContent>

        <TabsContent value="schedules">
          <SchedulesTab />
        </TabsContent>

        <TabsContent value="sustainability">
          <SustainabilityTab />
        </TabsContent>

        <TabsContent value="nevi">
          <NeviComplianceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
