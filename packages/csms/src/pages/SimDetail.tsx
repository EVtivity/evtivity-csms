// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { LoadingLogo } from '@/components/loading-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SimRefreshRangeDialog } from '@/components/sim/SimRefreshCard';
import { useSimRefresh } from '@/components/sim/use-sim-refresh';
import { SimAttachmentsTab } from '@/components/sims/SimAttachmentsTab';
import { SimDetailsTab } from '@/components/sims/SimDetailsTab';
import { SimSessionsTab } from '@/components/sims/SimSessionsTab';
import { simDetailKey, type SimDetailData } from '@/components/sims/sim-detail';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { useTab } from '@/hooks/use-tab';
import { api, ApiError } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';

/**
 * One SIM of the inventory. The page follows the SIM features (a SIM provider
 * or station signal reads): while both are off the API refuses every SIM
 * route, so the page says so instead of reading.
 */
export function SimDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const { flags, isLoading } = useFeatureFlags();
  if (isLoading) return <LoadingLogo />;
  if (!flags.simEnabled) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <BackButton to="/sims" />
          <h1 className="min-w-0 text-2xl md:text-3xl font-bold wrap-anywhere">
            {t('sims.title')}
          </h1>
        </div>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            {t('sims.featureOff')}
          </CardContent>
        </Card>
      </div>
    );
  }
  return <SimDetailLoader id={id} />;
}

function SimDetailLoader({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation();
  const sim = useQuery({
    queryKey: simDetailKey(id),
    queryFn: () => api.get<SimDetailData>(`/v1/sims/${id}`),
    enabled: id !== '',
    retry: false,
  });

  if (sim.isLoading) return <LoadingLogo />;
  if (sim.data == null) {
    const notFound = sim.error instanceof ApiError && sim.error.status === 404;
    return (
      <div className="space-y-6">
        <BackButton to="/sims" />
        {notFound ? (
          <p className="text-center text-sm text-muted-foreground">{t('sims.detail.notFound')}</p>
        ) : (
          <div className="space-y-2 text-center">
            <p className="text-sm text-destructive">{t('common.loadError')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void sim.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
      </div>
    );
  }
  // Keyed by id: Prev and Next start the Refresh state of the next SIM afresh.
  return <SimDetailView key={sim.data.id} sim={sim.data} />;
}

function SimDetailView({ sim }: { sim: SimDetailData }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const canReadAudit = useHasPermission('audit:read');
  const [activeTab, setActiveTab] = useTab('details');
  // One Refresh state for the Details and Sessions tabs: a Refresh moves the timeline window.
  const controller = useSimRefresh({ kind: 'sim', simId: sim.id }, sim);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/sims" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{sim.label ?? sim.iccid}</h1>
          <CopyableId id={sim.id} />
        </div>
        <EntityNavButtons resource="sims" basePath="/sims" currentId={sim.id} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('sims.detail.tabs.details')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sims.detail.tabs.sessions')}</TabsTrigger>
          <TabsTrigger value="attachments">{t('sims.detail.tabs.attachments')}</TabsTrigger>
          {canReadAudit && (
            <TabsTrigger value="history">{t('sims.detail.tabs.history')}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="details">
          <SimDetailsTab sim={sim} controller={controller} timezone={timezone} />
        </TabsContent>

        <TabsContent value="sessions">
          <SimSessionsTab sim={sim} controller={controller} timezone={timezone} />
        </TabsContent>

        <TabsContent value="attachments">
          <SimAttachmentsTab sim={sim} timezone={timezone} />
        </TabsContent>

        {canReadAudit && (
          <TabsContent value="history">
            <EntityHistoryTab entityType="sim" entityId={sim.id} />
          </TabsContent>
        )}
      </Tabs>

      <SimRefreshRangeDialog controller={controller} />
    </div>
  );
}
