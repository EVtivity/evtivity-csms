// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, PlugZap } from 'lucide-react';
import { formatVehicleId } from '@evtivity/lib/vehicle-id';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

export interface SessionVehicleCapture {
  value: string;
  type: string;
  source: string;
}

interface LinkedVehicle {
  id: string;
  vin?: string | null;
  evccid?: string | null;
  autochargeEnabled?: boolean;
}

interface DriverVehicle {
  id: string;
  make: string | null;
  model: string | null;
  year: string | null;
}

const NEW_VEHICLE = '__new__';

function vehicleName(v: DriverVehicle): string {
  return [v.year, v.make, v.model].filter((p) => p != null && p !== '').join(' ') || v.id;
}

/**
 * The vehicle id the charger sent for this session (Autocharge), with "Use
 * This Vehicle for Plug-In Charging" where the session's site offers
 * Autocharge and the linked vehicle does not already charge by plugging in
 * with this id.
 */
export function SessionVehicleCard({
  sessionId,
  capture,
  autocharge,
  autochargeAvailable,
  vehicle,
}: {
  sessionId: string;
  capture: SessionVehicleCapture;
  autocharge: boolean;
  autochargeAvailable: boolean;
  vehicle: LinkedVehicle | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [enableAutocharge, setEnableAutocharge] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const holdsId =
    vehicle != null && (vehicle.vin === capture.value || vehicle.evccid === capture.value);
  const canUse = autochargeAvailable && !(holdsId && vehicle.autochargeEnabled === true);

  const { data: vehicles } = useQuery({
    queryKey: ['portal-vehicles'],
    queryFn: () => api.get<DriverVehicle[]>('/v1/portal/vehicles'),
    enabled: open,
  });
  const selected = target ?? vehicle?.id ?? vehicles?.[0]?.id ?? NEW_VEHICLE;

  const claim = useMutation({
    mutationFn: () =>
      api.post(`/v1/portal/sessions/${sessionId}/vehicle-claim`, {
        ...(selected === NEW_VEHICLE
          ? { vehicle: { make: make.trim(), model: model.trim() } }
          : { vehicleId: selected }),
        enableAutocharge,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-session', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      toast({ variant: 'success', title: t('vehicles.autochargeSaved') });
      setOpen(false);
    },
    onError: (err) => {
      setError(getErrorMessage(err, t, 'vehicles.autochargeSaveFailed'));
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Car className="h-4 w-4" aria-hidden="true" />
          {t('vehicles.vehicleId')}
          {autocharge && (
            <Badge variant="info" className="gap-1">
              <PlugZap className="h-3 w-3" aria-hidden="true" />
              {t('vehicles.autocharge')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="font-mono text-sm" data-testid="session-vehicle-id">
            {formatVehicleId(capture.value)}{' '}
            <span className="font-sans text-xs text-muted-foreground">
              ({t(`vehicles.idTypes.${capture.type}`, { defaultValue: capture.type })})
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{t('vehicles.capturedFromCharger')}</p>
        </div>
        {canUse && (
          <Button
            className="w-full"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            <PlugZap className="h-4 w-4" aria-hidden="true" />
            {t('vehicles.useForPlugIn')}
          </Button>
        )}
      </CardContent>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (claim.isPending && !next) return;
          setOpen(next);
        }}
        title={t('vehicles.useForPlugIn')}
        description={t('vehicles.useForPlugInDescription', { id: formatVehicleId(capture.value) })}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
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
            <label htmlFor="claim-target" className="text-sm font-medium">
              {t('vehicles.vehicle')}
            </label>
            <Select
              id="claim-target"
              value={selected}
              onChange={(e) => {
                setTarget(e.target.value);
              }}
            >
              {(vehicles ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {vehicleName(v)}
                </option>
              ))}
              <option value={NEW_VEHICLE}>{t('vehicles.newVehicle')}</option>
            </Select>
          </div>
          {selected === NEW_VEHICLE && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                aria-label={t('vehicles.make')}
                placeholder={t('vehicles.make')}
                value={make}
                onChange={(e) => {
                  setMake(e.target.value);
                }}
              />
              <Input
                aria-label={t('vehicles.model')}
                placeholder={t('vehicles.model')}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                }}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{t('vehicles.autocharge')}</p>
              <p className="text-xs text-muted-foreground">{t('vehicles.autochargeHelp')}</p>
            </div>
            <Toggle
              aria-label={t('vehicles.autocharge')}
              checked={enableAutocharge}
              onCheckedChange={setEnableAutocharge}
            />
          </div>
          {error != null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </Card>
  );
}
