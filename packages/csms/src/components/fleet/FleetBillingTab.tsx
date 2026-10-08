// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

export interface FleetBillingTabProps {
  fleet: { id: string; accountBillingEnabled?: boolean };
}

/** Charge on account for the fleet: the members' sessions are billed to the fleet. */
export function FleetBillingTab({ fleet }: FleetBillingTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('fleets:write');
  const enabled = fleet.accountBillingEnabled === true;
  const [confirmOpen, setConfirmOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: (accountBillingEnabled: boolean) =>
      api.patch(`/v1/fleets/${fleet.id}/billing`, { accountBillingEnabled }),
    onSuccess: () => {
      toast({ title: t('fleets.billing.updated'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleet.id] });
      setConfirmOpen(false);
    },
    onError: (err) => {
      toast({
        title: t('fleets.billing.updateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
      setConfirmOpen(false);
    },
  });

  return (
    <Card data-testid="fleet-billing">
      <CardHeader>
        <CardTitle>{t('fleets.billing.title')}</CardTitle>
        <CardDescription>{t('fleets.billing.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <Toggle
            id="fleet-account-billing"
            checked={enabled}
            disabled={!canWrite || mutation.isPending}
            aria-label={t('fleets.billing.chargeOnAccount')}
            onCheckedChange={() => {
              setConfirmOpen(true);
            }}
          />
          <Label htmlFor="fleet-account-billing">{t('fleets.billing.chargeOnAccount')}</Label>
          <Badge variant={enabled ? 'success' : 'outline'}>
            {enabled ? t('fleets.billing.on') : t('fleets.billing.off')}
          </Badge>
        </div>
        <p className="text-muted-foreground">
          {enabled ? t('fleets.billing.helpOn') : t('fleets.billing.helpOff')}
        </p>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={enabled ? t('fleets.billing.disableTitle') : t('fleets.billing.enableTitle')}
        description={
          enabled ? t('fleets.billing.disableConfirm') : t('fleets.billing.enableConfirm')
        }
        confirmLabel={enabled ? t('fleets.billing.disable') : t('fleets.billing.enable')}
        variant="default"
        isPending={mutation.isPending}
        onConfirm={() => {
          mutation.mutate(!enabled);
          return false;
        }}
      />
    </Card>
  );
}
