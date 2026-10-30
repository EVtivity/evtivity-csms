// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { CreateButton } from '@/components/create-button';
import { TabPanel } from '@/components/ui/tab-panel';
import { VehiclesTable, type Vehicle } from '@/components/VehiclesTable';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';

interface FleetVehiclesTabProps {
  fleetId: string;
  /** The user may add and remove members (see FleetDetail). */
  canManageMembers?: boolean;
}

export function FleetVehiclesTab({
  fleetId,
  canManageMembers = true,
}: FleetVehiclesTabProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [page, setPage] = useState(1);
  const [removeDriverId, setRemoveDriverId] = useState<string | null>(null);
  const limit = 10;

  const {
    data: response,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['fleets', fleetId, 'vehicles', page],
    queryFn: () =>
      api.get<{ data: Vehicle[]; total: number }>(
        `/v1/fleets/${fleetId}/vehicles?page=${String(page)}&limit=${String(limit)}`,
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
      <TabPanel
        title={t('fleets.vehicles')}
        description={t('fleets.addVehicleNote')}
        actions={
          canManageMembers ? (
            <CreateButton
              label={t('fleets.addVehicle')}
              onClick={() => {
                void navigate(`/fleets/${fleetId}/vehicles/add`);
              }}
            />
          ) : undefined
        }
      >
        <VehiclesTable
          vehicles={response?.data}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          showDriver
          isLoading={isLoading}
          isError={isError}
          onRetry={() => {
            void refetch();
          }}
          onRowClick={(vehicle) => {
            void navigate(`/drivers/${vehicle.driverId}/vehicles/${vehicle.id}`);
          }}
          {...(canManageMembers
            ? {
                onDelete: (vehicle: { driverId: string }): void => {
                  setRemoveDriverId(vehicle.driverId);
                },
              }
            : {})}
        />
      </TabPanel>

      <ConfirmDialog
        open={removeDriverId != null}
        onOpenChange={(open) => {
          if (!open) setRemoveDriverId(null);
        }}
        title={t('fleets.removeVehicle')}
        description={t('fleets.confirmRemoveVehicle')}
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
