// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PricingGroupPickList } from '@/components/pricing/PricingGroupPickList';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import type { PricingGroup } from '@/lib/types';

export function SiteAssignPricing(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [pendingGroup, setPendingGroup] = useState<PricingGroup | null>(null);

  const { data: pricingGroups } = useQuery({
    queryKey: ['pricing-groups'],
    queryFn: () => api.get<PricingGroup[]>('/v1/pricing-groups'),
  });

  const { data: currentGroup } = useQuery({
    queryKey: ['sites', id, 'pricing-group'],
    queryFn: () => api.get<PricingGroup | null>(`/v1/sites/${id ?? ''}/pricing-groups`),
  });

  const assignMutation = useMutation({
    mutationFn: (pricingGroupId: string) =>
      api.post(`/v1/sites/${id ?? ''}/pricing-groups`, { pricingGroupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', id, 'pricing-group'] });
      void navigate(`/sites/${id ?? ''}?tab=pricing`);
    },
    onSettled: () => {
      setMutatingId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/sites/${id ?? ''}?tab=pricing`} />
        <h1 className="text-2xl md:text-3xl font-bold">{t('sites.assignPricingGroup')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          {assignMutation.isError && (
            <p className="mb-4 text-sm text-destructive">
              {getErrorMessage(assignMutation.error, t)}
            </p>
          )}

          <PricingGroupPickList
            groups={pricingGroups}
            currentGroupId={currentGroup?.id}
            pendingGroupId={mutatingId}
            isPending={assignMutation.isPending}
            emptyLabel={t('sites.noPricingGroupResults')}
            onSelect={setPendingGroup}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingGroup != null}
        onOpenChange={(open) => {
          if (!open) setPendingGroup(null);
        }}
        variant="default"
        title={t('sites.assignPricingGroup')}
        description={t('sites.confirmAssignPricing', { name: pendingGroup?.name ?? '' })}
        confirmLabel={t('common.confirm')}
        isPending={assignMutation.isPending}
        onConfirm={() => {
          if (pendingGroup != null) {
            setMutatingId(pendingGroup.id);
            assignMutation.mutate(pendingGroup.id);
            setPendingGroup(null);
          }
        }}
      />
    </div>
  );
}
