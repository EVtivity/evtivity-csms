// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface Vehicle {
  id: string;
  driverId: string;
  make: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  licensePlate: string | null;
}

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

  const updateMutation = useMutation({
    mutationFn: (body: {
      make?: string;
      model?: string;
      year?: string;
      vin?: string;
      licensePlate?: string;
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
    setHasSubmitted(false);
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!make.trim()) errors.make = t('validation.required');
    if (!model.trim()) errors.model = t('validation.required');
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    updateMutation.mutate({
      make,
      model,
      ...(year.trim() !== '' ? { year } : {}),
      ...(vin.trim() !== '' ? { vin } : {}),
      ...(licensePlate.trim() !== '' ? { licensePlate } : {}),
    });
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (vehicle == null) {
    return <p className="text-sm text-destructive">{t('vehicles.vehicleNotFound')}</p>;
  }

  const displayName = [vehicle.make, vehicle.model].filter(Boolean).join(' ') || '--';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to={`/drivers/${id ?? ''}?tab=vehicles`} />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{displayName}</h1>
          <CopyableId id={vehicle.id} />
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-make">{t('vehicles.make')}</Label>
                  <Input
                    id="edit-make"
                    value={make}
                    onChange={(e) => {
                      setMake(e.target.value);
                    }}
                    className={hasSubmitted && validationErrors.make ? 'border-destructive' : ''}
                  />
                  {hasSubmitted && validationErrors.make && (
                    <p className="text-sm text-destructive">{validationErrors.make}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-model">{t('vehicles.model')}</Label>
                  <Input
                    id="edit-model"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                    }}
                    className={hasSubmitted && validationErrors.model ? 'border-destructive' : ''}
                  />
                  {hasSubmitted && validationErrors.model && (
                    <p className="text-sm text-destructive">{validationErrors.model}</p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-year">{t('vehicles.year')}</Label>
                <Input
                  id="edit-year"
                  value={year}
                  onChange={(e) => {
                    setYear(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-vin">{t('vehicles.vin')}</Label>
                <Input
                  id="edit-vin"
                  value={vin}
                  onChange={(e) => {
                    setVin(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-plate">{t('vehicles.licensePlate')}</Label>
                <Input
                  id="edit-plate"
                  value={licensePlate}
                  onChange={(e) => {
                    setLicensePlate(e.target.value);
                  }}
                />
              </div>
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('vehicles.make')}</dt>
                <dd className="font-medium">{vehicle.make ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('vehicles.model')}</dt>
                <dd className="font-medium">{vehicle.model ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('vehicles.year')}</dt>
                <dd className="font-medium">{vehicle.year ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('vehicles.vin')}</dt>
                <dd className="font-medium">{vehicle.vin ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('vehicles.licensePlate')}</dt>
                <dd className="font-medium">{vehicle.licensePlate ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('vehicles.owner')}</dt>
                <dd className="font-medium">
                  {driver != null ? (
                    <Link to={`/drivers/${driver.id}`} className="text-primary hover:underline">
                      {driver.firstName} {driver.lastName}
                    </Link>
                  ) : (
                    '--'
                  )}
                </dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

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
      />
    </div>
  );
}
