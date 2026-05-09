// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import {
  FirmwareCampaignDetailsTab,
  type CampaignDetail,
} from '@/components/firmware-campaign/DetailsTab';
import { FirmwareCampaignHistoryTab } from '@/components/firmware-campaign/CampaignHistoryTab';
import { FirmwareCampaignMatchingStationsTab } from '@/components/firmware-campaign/MatchingStationsTab';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTab } from '@/hooks/use-tab';
import { api } from '@/lib/api';

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  draft: 'outline',
  active: 'warning',
  completed: 'success',
  cancelled: 'secondary',
};

export function FirmwareCampaignDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const campaignId = id ?? '';
  const [activeTab, setActiveTab] = useTab('details');

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['firmware-campaigns', campaignId],
    queryFn: () => api.get<CampaignDetail>(`/v1/firmware-campaigns/${campaignId}`),
    enabled: campaignId !== '',
  });

  // Lightweight count query for the Matching Stations tab badge.
  const { data: matchingTotal } = useQuery({
    queryKey: ['firmware-campaigns', campaignId, 'matching-stations', 'count'],
    queryFn: () =>
      api.get<{ total: number }>(
        `/v1/firmware-campaigns/${campaignId}/matching-stations?page=1&limit=1`,
      ),
    enabled: campaignId !== '',
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (campaign == null) {
    return <p className="text-destructive">{t('firmwareCampaigns.notFound')}</p>;
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/settings?tab=firmware" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{campaign.name}</h1>
          <CopyableId id={campaign.id} />
        </div>
        <Badge variant={STATUS_VARIANT[campaign.status] ?? 'outline'}>{campaign.status}</Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="history">{t('firmwareCampaigns.campaignHistory')}</TabsTrigger>
          <TabsTrigger value="matching" className="gap-2">
            {t('firmwareCampaigns.matchingStations')}
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-foreground/15 px-1.5 text-xs font-semibold">
              {matchingTotal?.total ?? 0}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details" className="space-y-6">
          <FirmwareCampaignDetailsTab campaign={campaign} />
        </TabsContent>
        <TabsContent value="history" className="space-y-6">
          <FirmwareCampaignHistoryTab campaignId={campaignId} />
        </TabsContent>
        <TabsContent value="matching" className="space-y-6">
          <FirmwareCampaignMatchingStationsTab campaignId={campaignId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
