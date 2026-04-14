// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { AddButton } from '@/components/add-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DriversTable } from '@/components/DriversTable';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';

interface FleetDriver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

interface FleetDriversTabProps {
  fleetId: string;
}

export function FleetDriversTab({ fleetId }: FleetDriversTabProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [page, setPage] = useState(1);
  const [removeDriverId, setRemoveDriverId] = useState<string | null>(null);
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

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{t('fleets.drivers')}</CardTitle>
            <CardDescription>{t('fleets.addDriverNote')}</CardDescription>
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
            onRemove={(driverId) => {
              setRemoveDriverId(driverId);
            }}
          />
        </CardContent>
      </Card>

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
