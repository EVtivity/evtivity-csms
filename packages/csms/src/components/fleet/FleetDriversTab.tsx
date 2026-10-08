// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { AddButton } from '@/components/add-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { DriversTable } from '@/components/DriversTable';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { useUserTimezone } from '@/lib/timezone';

interface FleetDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  /** The member pays by card although the fleet bills on account. */
  accountBillingOptOut?: boolean;
  createdAt: string;
}

interface FleetDriversTabProps {
  fleetId: string;
  /** The fleet bills its members' sessions on account. */
  accountBillingEnabled?: boolean;
}

export function FleetDriversTab({
  fleetId,
  accountBillingEnabled = false,
}: FleetDriversTabProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [page, setPage] = useState(1);
  const [removeDriverId, setRemoveDriverId] = useState<string | null>(null);
  const [billingChange, setBillingChange] = useState<{
    driverId: string;
    optOut: boolean;
  } | null>(null);
  const { toast } = useToast();
  const canWrite = useHasPermission('fleets:write');
  const limit = 10;

  const { data: response } = useQuery({
    queryKey: ['fleets', fleetId, 'drivers', page],
    queryFn: () =>
      api.get<{ data: FleetDriver[]; total: number }>(
        `/v1/fleets/${fleetId}/drivers?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = Math.max(1, Math.ceil((response?.total ?? 0) / limit));

  const removeDriverMutation = useMutation({
    mutationFn: (driverId: string) => api.delete(`/v1/fleets/${fleetId}/drivers/${driverId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'drivers'] });
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'vehicles'] });
    },
  });

  const billingMutation = useMutation({
    mutationFn: (change: { driverId: string; optOut: boolean }) =>
      api.patch(`/v1/fleets/${fleetId}/drivers/${change.driverId}`, {
        accountBillingOptOut: change.optOut,
      }),
    onSuccess: () => {
      toast({ title: t('fleets.billing.memberUpdated'), variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'drivers'] });
      setBillingChange(null);
    },
    onError: (err) => {
      toast({
        title: t('fleets.billing.updateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
      setBillingChange(null);
    },
  });

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{t('fleets.drivers')}</CardTitle>
            <CardDescription>{t('fleets.addDriverNote')}</CardDescription>
            {!accountBillingEnabled && (
              <CardDescription>{t('fleets.billing.memberNoteOff')}</CardDescription>
            )}
          </div>
          <AddButton
            label={t('fleets.addDriver')}
            onClick={() => {
              void navigate(`/fleets/${fleetId}/drivers/add`);
            }}
          />
        </CardHeader>
        <CardContent>
          <DriversTable
            drivers={response?.data}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            timezone={timezone}
            emptyMessage={t('fleets.noDrivers')}
            extraColumn={{
              header: t('fleets.billing.memberColumn'),
              render: (driver) => {
                const member = driver as FleetDriver;
                const onAccount = member.accountBillingOptOut !== true;
                return (
                  <Toggle
                    size="sm"
                    checked={onAccount}
                    disabled={!canWrite || billingMutation.isPending}
                    aria-label={t('fleets.billing.memberColumn')}
                    data-testid={`member-billing-${driver.id}`}
                    onCheckedChange={() => {
                      setBillingChange({ driverId: driver.id, optOut: onAccount });
                    }}
                  />
                );
              },
            }}
            onRemove={(driverId) => {
              setRemoveDriverId(driverId);
            }}
          />
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <ConfirmDialog
        open={billingChange != null}
        onOpenChange={(open) => {
          if (!open) setBillingChange(null);
        }}
        title={
          billingChange?.optOut === true
            ? t('fleets.billing.optOutTitle')
            : t('fleets.billing.optInTitle')
        }
        description={
          billingChange?.optOut === true
            ? t('fleets.billing.optOutConfirm')
            : t('fleets.billing.optInConfirm')
        }
        confirmLabel={t('common.confirm')}
        variant="default"
        isPending={billingMutation.isPending}
        onConfirm={() => {
          if (billingChange != null) billingMutation.mutate(billingChange);
          return false;
        }}
      />

      <ConfirmDialog
        open={removeDriverId != null}
        onOpenChange={(open) => {
          if (!open) setRemoveDriverId(null);
        }}
        title={t('fleets.removeDriver')}
        description={t('fleets.confirmRemoveDriver')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={removeDriverMutation.isPending}
        onConfirm={() => {
          if (removeDriverId != null) {
            removeDriverMutation.mutate(removeDriverId);
            setRemoveDriverId(null);
          }
        }}
      />
    </>
  );
}
