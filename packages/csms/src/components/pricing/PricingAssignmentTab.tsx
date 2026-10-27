// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PricingScheduleCard } from '@/components/pricing-schedule-card';
import { api } from '@/lib/api';
import { useHasCompanyWidePermission } from '@/lib/auth';
import type { PricingGroup } from '@/lib/types';

type ResourceType = 'station' | 'site' | 'driver' | 'fleet';

export interface PricingAssignmentTabProps {
  resourceType: ResourceType;
  resourceId: string;
  assignUrl: string;
  /** Timezone the schedule marks the current tariff in (default: the system timezone). */
  scheduleTimezone?: string | undefined;
}

const RESOURCE_PLURAL: Record<ResourceType, string> = {
  station: 'stations',
  site: 'sites',
  driver: 'drivers',
  fleet: 'fleets',
};

const I18N_KEYS = {
  station: {
    tab: 'stations.pricing' as const,
    description: 'stations.pricingDescription' as const,
    change: 'stations.changePricingGroup' as const,
    empty: 'stations.noPricingGroups' as const,
    assign: 'stations.assignPricingGroup' as const,
  },
  site: {
    tab: 'sites.pricing' as const,
    description: 'sites.pricingDescription' as const,
    change: 'sites.changePricingGroup' as const,
    empty: 'sites.noPricingGroups' as const,
    assign: 'sites.assignPricingGroup' as const,
  },
  driver: {
    tab: 'drivers.pricing' as const,
    description: 'drivers.pricingDescription' as const,
    change: 'drivers.changePricingGroup' as const,
    empty: 'drivers.noPricingGroups' as const,
    assign: 'drivers.assignPricingGroup' as const,
  },
  fleet: {
    tab: 'fleets.pricing' as const,
    description: 'fleets.pricingDescription' as const,
    change: 'fleets.changePricingGroup' as const,
    empty: 'fleets.noPricingGroups' as const,
    assign: 'fleets.assignPricingGroup' as const,
  },
};

export function PricingAssignmentTab({
  resourceType,
  resourceId,
  assignUrl,
  scheduleTimezone,
}: PricingAssignmentTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [removePricingOpen, setRemovePricingOpen] = useState(false);

  const plural = RESOURCE_PLURAL[resourceType];
  const keys = I18N_KEYS[resourceType];
  // A driver's or fleet's pricing group bills them at every site, so the API
  // lets only a user with access to all sites change it.
  const companyWideWrite = useHasCompanyWidePermission(`${plural}:write`);
  const canEdit = resourceType === 'driver' || resourceType === 'fleet' ? companyWideWrite : true;

  const {
    data: pricingGroup,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: [plural, resourceId, 'pricing-group'],
    queryFn: () => api.get<PricingGroup | null>(`/v1/${plural}/${resourceId}/pricing-groups`),
  });

  const removePricingGroupMutation = useMutation({
    mutationFn: (pricingGroupId: string) =>
      api.delete(`/v1/${plural}/${resourceId}/pricing-groups/${pricingGroupId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [plural, resourceId, 'pricing-group'] });
    },
  });

  return (
    <>
      <TabPanel
        title={t(keys.tab)}
        description={t(keys.description)}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => {
          void refetch();
        }}
        actions={
          pricingGroup != null && canEdit ? (
            <div className="flex flex-wrap gap-2 *:grow sm:*:grow-0">
              <EditButton
                label={t(keys.change)}
                onClick={() => {
                  void navigate(assignUrl);
                }}
              />
              <RemoveButton
                label={t('common.remove')}
                onClick={() => {
                  setRemovePricingOpen(true);
                }}
              />
            </div>
          ) : undefined
        }
      >
        {pricingGroup != null ? (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-lg font-semibold">
              {pricingGroup.name}
              {pricingGroup.isDefault && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary" title={t('common.default')} />
              )}
            </p>
            {pricingGroup.description && (
              <p className="text-sm text-muted-foreground">{pricingGroup.description}</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 py-6">
            <p data-testid="empty-state" className="text-center text-sm text-muted-foreground">
              {t(keys.empty)}
            </p>
            {canEdit && (
              <Button
                onClick={() => {
                  void navigate(assignUrl);
                }}
              >
                <Plus className="h-4 w-4" />
                {t(keys.assign)}
              </Button>
            )}
          </div>
        )}
      </TabPanel>
      {pricingGroup != null && (
        <PricingScheduleCard groupId={pricingGroup.id} timezone={scheduleTimezone} />
      )}

      {pricingGroup != null && (
        <ConfirmDialog
          open={removePricingOpen}
          onOpenChange={setRemovePricingOpen}
          title={t('common.remove')}
          description={t('pricing.confirmRemoveGroupDesc')}
          confirmLabel={t('common.remove')}
          confirmIcon={<Trash2 className="h-4 w-4" />}
          isPending={removePricingGroupMutation.isPending}
          onConfirm={() => {
            removePricingGroupMutation.mutate(pricingGroup.id);
          }}
        />
      )}
    </>
  );
}
