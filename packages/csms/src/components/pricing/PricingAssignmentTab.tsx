// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PricingScheduleCard } from '@/components/pricing-schedule-card';
import { api } from '@/lib/api';
import type { PricingGroup } from '@/lib/types';

type ResourceType = 'station' | 'site' | 'driver' | 'fleet';

export interface PricingAssignmentTabProps {
  resourceType: ResourceType;
  resourceId: string;
  assignUrl: string;
}

const RESOURCE_PLURAL: Record<ResourceType, string> = {
  station: 'stations',
  site: 'sites',
  driver: 'drivers',
  fleet: 'fleets',
};

const I18N_KEYS = {
  station: {
    description: 'stations.pricingDescription' as const,
    change: 'stations.changePricingGroup' as const,
    empty: 'stations.noPricingGroups' as const,
    assign: 'stations.assignPricingGroup' as const,
  },
  site: {
    description: 'sites.pricingDescription' as const,
    change: 'sites.changePricingGroup' as const,
    empty: 'sites.noPricingGroups' as const,
    assign: 'sites.assignPricingGroup' as const,
  },
  driver: {
    description: 'drivers.pricingDescription' as const,
    change: 'drivers.changePricingGroup' as const,
    empty: 'drivers.noPricingGroups' as const,
    assign: 'drivers.assignPricingGroup' as const,
  },
  fleet: {
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
}: PricingAssignmentTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [removePricingOpen, setRemovePricingOpen] = useState(false);

  const plural = RESOURCE_PLURAL[resourceType];
  const keys = I18N_KEYS[resourceType];

  const { data: pricingGroup } = useQuery({
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
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">{t(keys.description)}</p>
        </CardContent>
      </Card>
      {pricingGroup != null ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {pricingGroup.name}
                    {pricingGroup.isDefault && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-primary"
                        title={t('common.default')}
                      />
                    )}
                  </CardTitle>
                  {pricingGroup.description && (
                    <CardDescription>{pricingGroup.description}</CardDescription>
                  )}
                </div>
                <div className="flex gap-2">
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
              </div>
            </CardHeader>
          </Card>

          <PricingScheduleCard groupId={pricingGroup.id} />
        </>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
            <p className="text-sm text-muted-foreground">{t(keys.empty)}</p>
            <Button
              onClick={() => {
                void navigate(assignUrl);
              }}
            >
              <Plus className="h-4 w-4" />
              {t(keys.assign)}
            </Button>
          </CardContent>
        </Card>
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
