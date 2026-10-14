// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap } from 'lucide-react';
import { formatVehicleId } from '@evtivity/lib/vehicle-id';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { UseVehicleButton } from '@/components/use-vehicle-button';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

export interface SessionVehicleCapture {
  value: string;
  type: string;
  source: string;
}

export interface SessionVehicleInfo {
  id: string;
  make: string | null;
  model: string | null;
  year: string | null;
  licensePlate?: string | null;
  autochargeEnabled?: boolean;
}

/** A vehicle's display name: year, make and model, else its license plate. */
export function vehicleDisplayName(v: {
  make: string | null;
  model: string | null;
  year: string | null;
  licensePlate?: string | null;
}): string {
  const name = [v.year, v.make, v.model].filter((p) => p != null && p !== '').join(' ');
  return name !== '' ? name : (v.licensePlate ?? '');
}

/** The captured id as shown: a MAC address with colons, with its type. */
export function CapturedVehicleId({
  capture,
}: {
  capture: SessionVehicleCapture;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="font-mono text-sm">
      {formatVehicleId(capture.value)}{' '}
      <span className="font-sans text-xs text-muted-foreground">
        ({t(`vehicles.idTypes.${capture.type}`, { defaultValue: capture.type })})
      </span>
    </span>
  );
}

interface DriverVehicle {
  id: string;
  make: string | null;
  model: string | null;
  year: string | null;
  licensePlate: string | null;
}

/**
 * The Vehicle row of the session overview: the linked vehicle (an Autocharge
 * badge when the vehicle started the session), the id the charger sent with
 * "Captured from the charger", and, for a session with a driver, Use This
 * Vehicle for Plug-In Charging.
 */
export function SessionVehicle({
  sessionId,
  driverId,
  vehicle,
  capture,
  autocharge,
}: {
  sessionId: string;
  driverId: string | null;
  vehicle: SessionVehicleInfo | null;
  capture: SessionVehicleCapture | null;
  autocharge: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('drivers:write');
  const [open, setOpen] = useState(false);
  if (vehicle == null && capture == null) return <span>n/a</span>;
  const vehicleOwnsId = vehicle?.autochargeEnabled === true;
  return (
    <div className="space-y-1">
      {vehicle != null && driverId != null && (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/drivers/${driverId}/vehicles/${vehicle.id}`}
            className="text-link hover:underline"
          >
            {vehicleDisplayName(vehicle) || vehicle.id}
          </Link>
          {autocharge && (
            <Badge variant="info" className="gap-1">
              <PlugZap className="h-3 w-3" aria-hidden="true" />
              {t('vehicles.autocharge')}
            </Badge>
          )}
        </div>
      )}
      {capture != null && (
        <div className="space-y-0.5">
          <CapturedVehicleId capture={capture} />
          <p className="text-xs text-muted-foreground">{t('sessions.capturedFromCharger')}</p>
        </div>
      )}
      {capture != null && driverId != null && canWrite && !vehicleOwnsId && (
        <div className="pt-2">
          <UseVehicleButton
            label={t('sessions.useVehicleForPlugIn')}
            onClick={() => {
              setOpen(true);
            }}
          />
          <VehicleClaimDialog
            open={open}
            onOpenChange={setOpen}
            sessionId={sessionId}
            driverId={driverId}
            capture={capture}
            linkedVehicleId={vehicle?.id ?? null}
          />
        </div>
      )}
    </div>
  );
}

const NEW_VEHICLE = '__new__';

function VehicleClaimDialog({
  open,
  onOpenChange,
  sessionId,
  driverId,
  capture,
  linkedVehicleId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  driverId: string;
  capture: SessionVehicleCapture;
  linkedVehicleId: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [enableAutocharge, setEnableAutocharge] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: vehicles } = useQuery({
    queryKey: ['drivers', driverId, 'vehicles'],
    queryFn: () => api.get<DriverVehicle[]>(`/v1/drivers/${driverId}/vehicles`),
    enabled: open,
  });
  const selected = target ?? linkedVehicleId ?? vehicles?.[0]?.id ?? NEW_VEHICLE;

  const claim = useMutation({
    mutationFn: () =>
      api.post(`/v1/sessions/${sessionId}/vehicle-claim`, {
        ...(selected === NEW_VEHICLE
          ? { vehicle: { make: make.trim(), model: model.trim() } }
          : { vehicleId: selected }),
        enableAutocharge,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sessions', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['drivers', driverId, 'vehicles'] });
      toast({ variant: 'success', title: t('sessions.vehicleClaimed') });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(getErrorMessage(err, t));
    },
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      variant="default"
      title={t('sessions.useVehicleForPlugIn')}
      description={t('sessions.useVehicleDescription', {
        id: formatVehicleId(capture.value),
      })}
      confirmLabel={t('common.save')}
      isPending={claim.isPending}
      onConfirm={() => {
        if (selected === NEW_VEHICLE && (make.trim() === '' || model.trim() === '')) {
          setError(t('vehicles.makeModelRequired'));
          return false;
        }
        setError(null);
        claim.mutate();
        return false;
      }}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="claim-target" className="leading-6">
            {t('vehicles.vehicle')}
          </Label>
          <Select
            id="claim-target"
            value={selected}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
          >
            {(vehicles ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {vehicleDisplayName(v) || v.id}
              </option>
            ))}
            <option value={NEW_VEHICLE}>{t('vehicles.newVehicle')}</option>
          </Select>
        </div>
        {selected === NEW_VEHICLE && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="claim-make" className="leading-6">
                {t('vehicles.make')}
              </Label>
              <Input
                id="claim-make"
                value={make}
                onChange={(e) => {
                  setMake(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-model" className="leading-6">
                {t('vehicles.model')}
              </Label>
              <Input
                id="claim-model"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('vehicles.autocharge')}</Label>
            <p className="text-xs text-muted-foreground">{t('vehicles.autochargeHelp')}</p>
          </div>
          <Toggle
            aria-label={t('vehicles.autocharge')}
            checked={enableAutocharge}
            onCheckedChange={setEnableAutocharge}
          />
        </div>
        {error != null && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}
