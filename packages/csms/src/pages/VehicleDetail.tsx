// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CopyableId } from '@/components/copyable-id';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Toggle } from '@/components/ui/toggle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { BlockButton, UnblockButton } from '@/components/block-button';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { useTab } from '@/hooks/use-tab';
import { LoadingLogo } from '@/components/loading-logo';
import { formatVehicleId, normalizeEvccid } from '@evtivity/lib/vehicle-id';

interface Vehicle {
  id: string;
  driverId: string;
  make: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  licensePlate: string | null;
  evccid: string | null;
  autochargeEnabled: boolean;
  autochargeBlockedAt: string | null;
  lastSeen: { stationId: string; siteName: string | null; at: string } | null;
}

interface VehicleLookup {
  makes: string[];
  models: { make: string; model: string }[];
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS: string[] = Array.from({ length: CURRENT_YEAR + 1 - 2010 + 1 }, (_, i) =>
  String(CURRENT_YEAR + 1 - i),
);

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
}

export function VehicleDetail(): React.JSX.Element {
  const { id, vehicleId } = useParams<{ id: string; vehicleId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { toast } = useToast();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('drivers:write');
  const canReadAudit = useHasPermission('audit:read');
  const [activeTab, setActiveTab] = useTab('details');
  const [blockOpen, setBlockOpen] = useState(false);
  const [evccid, setEvccid] = useState('');

  const [editing, setEditing] = useState(false);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [vin, setVin] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: vehicle, isLoading } = useQuery({
    queryKey: ['drivers', id, 'vehicles', vehicleId],
    queryFn: () => api.get<Vehicle>(`/v1/drivers/${id ?? ''}/vehicles/${vehicleId ?? ''}`),
    enabled: id != null && vehicleId != null,
  });

  const { data: driver } = useQuery({
    queryKey: ['drivers', id],
    queryFn: () => api.get<Driver>(`/v1/drivers/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: lookup } = useQuery({
    queryKey: ['vehicle-lookup'],
    queryFn: () => api.get<VehicleLookup>('/v1/vehicles/lookup'),
    staleTime: 5 * 60 * 1000,
  });

  const filteredModels = useMemo(() => {
    if (lookup == null) return [];
    const trimmed = make.trim().toLowerCase();
    if (trimmed === '') return lookup.models.map((m) => m.model);
    return lookup.models.filter((m) => m.make.toLowerCase() === trimmed).map((m) => m.model);
  }, [lookup, make]);

  const autochargeMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<Vehicle>(`/v1/drivers/${id ?? ''}/vehicles/${vehicleId ?? ''}`, {
        autochargeEnabled: enabled,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'vehicles'] });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const blockMutation = useMutation({
    mutationFn: (blocked: boolean) =>
      api.post<Vehicle>(
        `/v1/drivers/${id ?? ''}/vehicles/${vehicleId ?? ''}/${blocked ? 'block' : 'unblock'}`,
        {},
      ),
    onSuccess: (_data, blocked) => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'vehicles'] });
      toast({
        variant: 'success',
        title: t(blocked ? 'vehicles.blockedToast' : 'vehicles.unblockedToast'),
      });
      setBlockOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      make?: string;
      model?: string;
      year?: string | null;
      vin?: string | null;
      licensePlate?: string | null;
      evccid?: string | null;
    }) => api.patch<Vehicle>(`/v1/drivers/${id ?? ''}/vehicles/${vehicleId ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'vehicles', vehicleId] });
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'vehicles'] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<undefined>(`/v1/drivers/${id ?? ''}/vehicles/${vehicleId ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'vehicles'] });
      void navigate(`/drivers/${id ?? ''}?tab=vehicles`);
    },
  });

  function startEdit(): void {
    if (vehicle == null) return;
    setMake(vehicle.make ?? '');
    setModel(vehicle.model ?? '');
    setYear(vehicle.year ?? '');
    setVin(vehicle.vin ?? '');
    setLicensePlate(vehicle.licensePlate ?? '');
    setEvccid(vehicle.evccid != null ? formatVehicleId(vehicle.evccid) : '');
    setHasSubmitted(false);
    updateMutation.reset();
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!make.trim()) errors.make = t('validation.required');
    if (!model.trim()) errors.model = t('validation.required');
    if (year.trim() !== '' && !/^\d{4}$/.test(year.trim())) {
      errors.year = t('vehicles.yearFormat');
    }
    if (vin.trim() !== '' && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) {
      errors.vin = t('vehicles.vinFormat');
    }
    if (evccid.trim() !== '' && normalizeEvccid(evccid) == null) {
      errors.evccid = t('vehicles.evccidFormat');
    }
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    // An emptied optional field removes the stored value.
    const optional = (value: string, stored: string | null): string | null | undefined => {
      const trimmed = value.trim();
      if (trimmed !== '') return trimmed;
      return stored != null ? null : undefined;
    };
    const yearValue = optional(year, vehicle?.year ?? null);
    const vinValue = optional(vin, vehicle?.vin ?? null);
    const plateValue = optional(licensePlate, vehicle?.licensePlate ?? null);
    const evccidValue = optional(evccid, vehicle?.evccid ?? null);
    updateMutation.mutate({
      make,
      model,
      ...(yearValue !== undefined ? { year: yearValue } : {}),
      ...(vinValue !== undefined ? { vin: vinValue } : {}),
      ...(plateValue !== undefined ? { licensePlate: plateValue } : {}),
      ...(evccidValue !== undefined ? { evccid: evccidValue } : {}),
    });
  }

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (vehicle == null) {
    return <p className="text-sm text-destructive">{t('vehicles.vehicleNotFound')}</p>;
  }

  const displayName = [vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'n/a';
  const blocked = vehicle.autochargeBlockedAt != null;
  const hasVehicleId = vehicle.vin != null || vehicle.evccid != null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to={`/drivers/${id ?? ''}?tab=vehicles`} />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{displayName}</h1>
          <CopyableId id={vehicle.id} />
        </div>
        {blocked && <Badge variant="destructive">{t('vehicles.blocked')}</Badge>}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="details" className="mt-4 space-y-6">
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>{t('common.details')}</CardTitle>
              <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
                {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
                <RemoveButton
                  label={t('common.delete')}
                  onClick={() => {
                    setDeleteOpen(true);
                  }}
                />
              </div>
            </CardHeader>
            <CardContent>
              {editing ? (
                <form onSubmit={handleSave} noValidate className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-make" className="leading-6">
                        {t('vehicles.make')}
                      </Label>
                      <Combobox
                        id="edit-make"
                        value={make}
                        onChange={setMake}
                        options={lookup?.makes ?? []}
                        className={
                          hasSubmitted && validationErrors.make ? 'border-destructive' : ''
                        }
                      />
                      {hasSubmitted && validationErrors.make && (
                        <p className="text-sm text-destructive">{validationErrors.make}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-model" className="leading-6">
                        {t('vehicles.model')}
                      </Label>
                      <Combobox
                        id="edit-model"
                        value={model}
                        onChange={setModel}
                        options={filteredModels}
                        className={
                          hasSubmitted && validationErrors.model ? 'border-destructive' : ''
                        }
                      />
                      {hasSubmitted && validationErrors.model && (
                        <p className="text-sm text-destructive">{validationErrors.model}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-year" className="leading-6">
                        {t('vehicles.year')}
                      </Label>
                      <Combobox
                        id="edit-year"
                        value={year}
                        onChange={setYear}
                        options={YEAR_OPTIONS}
                        inputMode="numeric"
                        maxLength={4}
                        className={
                          hasSubmitted && validationErrors.year ? 'border-destructive' : ''
                        }
                      />
                      {hasSubmitted && validationErrors.year && (
                        <p className="text-sm text-destructive">{validationErrors.year}</p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-vin" className="leading-6">
                        {t('vehicles.vin')}
                      </Label>
                      <Input
                        id="edit-vin"
                        value={vin}
                        onChange={(e) => {
                          setVin(e.target.value);
                        }}
                        maxLength={17}
                        className={hasSubmitted && validationErrors.vin ? 'border-destructive' : ''}
                      />
                      {hasSubmitted && validationErrors.vin && (
                        <p className="text-sm text-destructive">{validationErrors.vin}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-plate" className="leading-6">
                        {t('vehicles.licensePlate')}
                      </Label>
                      <Input
                        id="edit-plate"
                        value={licensePlate}
                        onChange={(e) => {
                          setLicensePlate(e.target.value);
                        }}
                      />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="edit-evccid" className="leading-6">
                        {t('vehicles.evccid')}
                      </Label>
                      <Input
                        id="edit-evccid"
                        value={evccid}
                        onChange={(e) => {
                          setEvccid(e.target.value);
                        }}
                        maxLength={255}
                        className={
                          hasSubmitted && validationErrors.evccid ? 'border-destructive' : ''
                        }
                      />
                      <p className="text-xs text-muted-foreground">{t('vehicles.evccidHelp')}</p>
                      {hasSubmitted && validationErrors.evccid && (
                        <p className="text-sm text-destructive">{validationErrors.evccid}</p>
                      )}
                    </div>
                  </div>
                  {updateMutation.isError && (
                    <p className="text-sm text-destructive">
                      {getErrorMessage(updateMutation.error, t)}
                    </p>
                  )}
                  <div className="flex justify-end gap-2">
                    <CancelButton
                      onClick={() => {
                        setEditing(false);
                        setHasSubmitted(false);
                      }}
                    />
                    <SaveButton isPending={updateMutation.isPending} />
                  </div>
                </form>
              ) : (
                <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.make')}</dt>
                    <dd className="font-medium">{vehicle.make ?? 'n/a'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.model')}</dt>
                    <dd className="font-medium">{vehicle.model ?? 'n/a'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.year')}</dt>
                    <dd className="font-medium">{vehicle.year ?? 'n/a'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.vin')}</dt>
                    <dd className="font-medium">{vehicle.vin ?? 'n/a'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.licensePlate')}</dt>
                    <dd className="font-medium">{vehicle.licensePlate ?? 'n/a'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.evccid')}</dt>
                    <dd className="font-medium font-mono">
                      {vehicle.evccid != null ? formatVehicleId(vehicle.evccid) : 'n/a'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('vehicles.owner')}</dt>
                    <dd className="font-medium">
                      {driver != null ? (
                        <Link to={`/drivers/${driver.id}`} className="text-link hover:underline">
                          {driver.firstName} {driver.lastName}
                        </Link>
                      ) : (
                        'n/a'
                      )}
                    </dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>{t('vehicles.autocharge')}</CardTitle>
              {canWrite &&
                (blocked ? (
                  <UnblockButton
                    label={t('vehicles.unblock')}
                    onClick={() => {
                      setBlockOpen(true);
                    }}
                  />
                ) : (
                  <BlockButton
                    label={t('vehicles.block')}
                    onClick={() => {
                      setBlockOpen(true);
                    }}
                  />
                ))}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label className="leading-6">{t('vehicles.autocharge')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {hasVehicleId ? t('vehicles.autochargeHelp') : t('vehicles.autochargeNeedsId')}
                  </p>
                </div>
                <Toggle
                  aria-label={t('vehicles.autocharge')}
                  size="lg"
                  checked={vehicle.autochargeEnabled}
                  disabled={!canWrite || autochargeMutation.isPending || !hasVehicleId}
                  onCheckedChange={(checked) => {
                    autochargeMutation.mutate(checked);
                  }}
                />
              </div>
              {blocked && (
                <p className="text-sm text-destructive">{t('vehicles.blockedDescription')}</p>
              )}
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t('vehicles.lastSeen')}</dt>
                  <dd className="font-medium">
                    {vehicle.lastSeen != null
                      ? t('vehicles.lastSeenValue', {
                          station: vehicle.lastSeen.stationId,
                          time: formatDateTime(vehicle.lastSeen.at, timezone),
                        })
                      : t('vehicles.neverSeen')}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        {canReadAudit && (
          <TabsContent value="history" className="mt-4">
            <EntityHistoryTab entityType="vehicle" entityId={vehicle.id} />
          </TabsContent>
        )}
      </Tabs>

      <ConfirmDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        variant={blocked ? 'default' : 'destructive'}
        title={t(blocked ? 'vehicles.unblock' : 'vehicles.block')}
        description={t(blocked ? 'vehicles.confirmUnblockDesc' : 'vehicles.confirmBlockDesc')}
        confirmLabel={t(blocked ? 'vehicles.unblock' : 'vehicles.block')}
        isPending={blockMutation.isPending}
        onConfirm={() => {
          blockMutation.mutate(!blocked);
          return false;
        }}
      >
        {blockMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(blockMutation.error, t)}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('vehicles.deleteVehicle')}
        description={t('vehicles.confirmDeleteDesc')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      >
        {deleteMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(deleteMutation.error, t)}</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
