// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { GenerateTab } from '@/components/reports/GenerateTab';
import { GeneratedReportsTab } from '@/components/reports/GeneratedReportsTab';
import { SchedulesTab } from '@/components/reports/SchedulesTab';
import { NeviComplianceTab } from '@/components/reports/NeviComplianceTab';
import { SustainabilityTab } from '@/components/reports/SustainabilityTab';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { useHasPermission } from '@/lib/auth';

export function Reports(): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useTab('generate');
  const canReadAudit = useHasPermission('audit:read');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{t('reports.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('reports.subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="generate">{t('reports.generateTab')}</TabsTrigger>
          <TabsTrigger value="schedules">{t('reports.schedulesTab')}</TabsTrigger>
          <TabsTrigger value="sustainability">{t('nav.sustainability')}</TabsTrigger>
          <TabsTrigger value="nevi">{t('nevi.title')}</TabsTrigger>
          <TabsTrigger value="generated">{t('reports.generatedReportsTab')}</TabsTrigger>
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="generate">
          <GenerateTab
            onGenerated={() => {
              setTab('generated');
            }}
          />
        </TabsContent>

        <TabsContent value="generated">
          <GeneratedReportsTab />
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

        {canReadAudit && (
          <TabsContent value="history">
            {/* Report schedule changes, and generated, downloaded and deleted reports. */}
            <EntityHistoryTab
              entityType="report_schedule"
              entityId={null}
              extraColumns={[
                {
                  header: t('common.name'),
                  className: 'text-sm font-medium',
                  render: (row) => {
                    const after = row.after as { name?: string } | null;
                    const before = row.before as { name?: string } | null;
                    return after?.name ?? before?.name ?? row.entityIdSnapshot;
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
