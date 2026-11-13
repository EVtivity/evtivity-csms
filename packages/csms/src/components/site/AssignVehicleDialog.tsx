// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Binds a vehicle to an active session the CSMS could not identify (PUT
// /v1/sessions/:id/vehicle). Only the vehicle changes, never the driver or the
// billing; the API accepts a vehicle of the session's driver or of a driver of
// a fleet that holds the station.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SaveButton } from '@/components/save-button';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { EmptyState } from '@/components/ui/content-state';
import { useSavedToast } from '@/components/saved-message';
import {
  siteChargingPlanKey,
  vehicleLabel,
  type FleetVehicleOption,
} from '../fleet/departure-types';

export interface UnidentifiedSession {
  sessionId: string;
  stationId: string;
  stationOcppId: string;
  evseId: number | null;
  driverId?: string | null;
  startedAt: string | null;
}

interface AssignVehicleDialogProps {
  siteId: string;
  /** The session to bind; null closes the dialog. */
  session: UnidentifiedSession | null;
  /** Vehicles of the depot's departures, offered first. */
  depotVehicles: readonly FleetVehicleOption[];
  onClose: () => void;
}

export function AssignVehicleDialog({
  siteId,
  session,
  depotVehicles,
  onClose,
}: AssignVehicleDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Dialog
      open={session != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('sites.fleetReadiness.assignVehicle')}</DialogTitle>
          <DialogDescription>
            {session != null
              ? t('sites.fleetReadiness.assignVehicleDescription', {
                  station: session.stationOcppId,
                })
              : ''}
          </DialogDescription>
        </DialogHeader>
        {session != null && (
          <AssignForm
            siteId={siteId}
            session={session}
            depotVehicles={depotVehicles}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignForm({
  siteId,
  session,
  depotVehicles,
  onClose,
}: {
  siteId: string;
  session: UnidentifiedSession;
  depotVehicles: readonly FleetVehicleOption[];
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const savedToast = useSavedToast();
  const queryClient = useQueryClient();
  const canReadDrivers = useHasPermission('drivers:read');
  const driverId = session.driverId ?? null;
  const [vehicleId, setVehicleId] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const driverVehicles = useQuery({
    queryKey: ['drivers', driverId, 'vehicles', 'assign'],
    queryFn: () => api.get<FleetVehicleOption[]>(`/v1/drivers/${driverId ?? ''}/vehicles`),
    enabled: driverId != null && canReadDrivers,
  });
  const ownList = driverVehicles.data ?? [];
  const ownIds = new Set(ownList.map((v) => v.id));
  const others = depotVehicles.filter((v) => !ownIds.has(v.id));
  // Nothing to pick once the driver's vehicles are read (or cannot be).
  const noneListed = ownList.length === 0 && others.length === 0 && !driverVehicles.isLoading;

  const mutation = useMutation({
    mutationFn: (id: string) =>
      api.put(`/v1/sessions/${session.sessionId}/vehicle`, { vehicleId: id }),
    onSuccess: () => {
      savedToast();
      void queryClient.invalidateQueries({ queryKey: siteChargingPlanKey(siteId) });
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'layout'] });
      onClose();
    },
  });

  const error = hasSubmitted && vehicleId === '' ? t('validation.selectRequired') : null;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setHasSubmitted(true);
        if (vehicleId === '') return;
        mutation.mutate(vehicleId);
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="assign-vehicle">{t('fleets.departures.vehicle')}</Label>
        <Select
          id="assign-vehicle"
          value={vehicleId}
          onChange={(e) => {
            setVehicleId(e.target.value);
          }}
          className={error != null ? 'border-destructive' : ''}
        >
          <option value="">{t('fleets.departures.selectVehicle')}</option>
          {ownList.length > 0 && (
            <optgroup label={t('sites.fleetReadiness.driverVehicles')}>
              {ownList.map((v) => (
                <option key={v.id} value={v.id}>
                  {vehicleLabel(v)}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label={t('sites.fleetReadiness.depotVehicles')}>
              {others.map((v) => (
                <option key={v.id} value={v.id}>
                  {vehicleLabel(v)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        <p className="text-xs text-muted-foreground">
          {t('sites.fleetReadiness.assignVehicleHelp')}
        </p>
        {noneListed && <EmptyState>{t('sites.fleetReadiness.noVehicleToAssign')}</EmptyState>}
        {error != null && <p className="text-sm text-destructive">{error}</p>}
      </div>
      {mutation.isError && (
        <p className="text-sm text-destructive">
          {getErrorMessage(mutation.error, t, 'sites.fleetReadiness.assignFailed')}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <SaveButton
          isPending={mutation.isPending}
          label={t('sites.fleetReadiness.assignVehicle')}
        />
      </DialogFooter>
    </form>
  );
}
