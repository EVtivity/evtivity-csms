// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { ConfigTemplateDetailsTab } from '@/components/config-template/DetailsTab';
import type { TemplateDetail } from '@/components/config-template/DetailsTab';
import { ConfigTemplatePushHistoryTab } from '@/components/config-template/PushHistoryTab';
import { ConfigTemplateMatchingStationsTab } from '@/components/config-template/MatchingStationsTab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTab } from '@/hooks/use-tab';
import { api } from '@/lib/api';

export function ConfigTemplateDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const templateId = id ?? '';
  const [activeTab, setActiveTab] = useTab('details');

  const { data: template, isLoading } = useQuery({
    queryKey: ['config-templates', templateId],
    queryFn: () => api.get<TemplateDetail>(`/v1/config-templates/${templateId}`),
    enabled: templateId !== '',
  });

  // Lightweight count fetch for the Matching Stations tab badge. Independent
  // of the in-tab paginated/filtered query so the badge always reflects the
  // total match count regardless of the user's status filter selection.
  const { data: matchingTotal } = useQuery({
    queryKey: ['config-templates', templateId, 'matching-stations', 'count'],
    queryFn: () =>
      api.get<{ total: number }>(
        `/v1/config-templates/${templateId}/matching-stations?page=1&limit=1`,
      ),
    enabled: templateId !== '',
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (template == null) {
    return <p className="text-destructive">{t('configTemplates.notFound')}</p>;
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/settings?tab=configuration" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{template.name}</h1>
          <CopyableId id={template.id} />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="pushes">{t('configTemplates.pushHistory')}</TabsTrigger>
          <TabsTrigger value="matching" className="gap-2">
            {t('firmwareCampaigns.matchingStations')}
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-foreground/15 px-1.5 text-xs font-semibold">
              {matchingTotal?.total ?? 0}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details" className="space-y-6">
          <ConfigTemplateDetailsTab template={template} />
        </TabsContent>
        <TabsContent value="pushes" className="space-y-6">
          <ConfigTemplatePushHistoryTab templateId={templateId} />
        </TabsContent>
        <TabsContent value="matching" className="space-y-6">
          <ConfigTemplateMatchingStationsTab templateId={templateId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
