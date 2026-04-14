// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams, useNavigate } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PricingGroupDetailsTab } from '@/components/pricing/PricingGroupDetailsTab';
import { PricingGroupTariffsTab } from '@/components/pricing/PricingGroupTariffsTab';
import { PricingGroupScheduleTab } from '@/components/pricing/PricingGroupScheduleTab';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';
import type { PricingGroup } from '@/lib/types';

export function PricingGroupDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [tab, setTab] = useTab('details');

  const { data: group, isLoading } = useQuery({
    queryKey: ['pricing-groups', id],
    queryFn: () => api.get<PricingGroup>(`/v1/pricing-groups/${id ?? ''}`),
    enabled: id != null,
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (group == null) {
    return <p className="text-sm text-destructive">{t('pricing.groupDetails')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/pricing" />
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">{group.name}</h1>
          <CopyableId id={group.id} />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="tariffs">{t('pricing.tariffs')}</TabsTrigger>
          <TabsTrigger value="schedule">{t('pricing.schedule')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <PricingGroupDetailsTab
            group={group}
            timezone={timezone}
            onDeleted={() => {
              void navigate('/pricing');
            }}
          />
        </TabsContent>

        <TabsContent value="tariffs" className="space-y-6">
          <PricingGroupTariffsTab groupId={id ?? ''} />
        </TabsContent>

        <TabsContent value="schedule" className="space-y-6">
          <PricingGroupScheduleTab groupId={id ?? ''} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
