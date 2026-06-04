// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import type { PricingGroup } from '@/lib/types';

export function DriverAssignPricing(): React.JSX.Element {
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

  const assignMutation = useMutation({
    mutationFn: (pricingGroupId: string) =>
      api.post(`/v1/drivers/${id ?? ''}/pricing-groups`, { pricingGroupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'pricing-group'] });
      void navigate(`/drivers/${id ?? ''}?tab=pricing`);
    },
    onSettled: () => {
      setMutatingId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/drivers/${id ?? ''}?tab=pricing`} />
        <h1 className="text-2xl md:text-3xl font-bold">{t('drivers.assignPricingGroup')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          {assignMutation.isError && (
            <p className="mb-4 text-sm text-destructive">
              {getErrorMessage(assignMutation.error, t)}
            </p>
          )}

          <div className="space-y-1">
            {pricingGroups != null && pricingGroups.length > 0 ? (
              pricingGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => {
                    setPendingGroup(group);
                  }}
                  disabled={assignMutation.isPending}
                >
                  {mutatingId === group.id && assignMutation.isPending && (
                    <Spinner className="h-4 w-4 shrink-0" />
                  )}
                  <span className="font-medium">{group.name}</span>
                  {group.description != null && (
                    <span className="text-muted-foreground">{group.description}</span>
                  )}
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                {t('drivers.noPricingGroupResults')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingGroup != null}
        onOpenChange={(open) => {
          if (!open) setPendingGroup(null);
        }}
        variant="default"
        title={t('drivers.assignPricingGroup')}
        description={t('drivers.confirmAssignPricing', { name: pendingGroup?.name ?? '' })}
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
