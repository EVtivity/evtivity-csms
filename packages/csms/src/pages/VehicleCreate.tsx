// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Vehicle {
  id: string;
  driverId: string;
  make: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  licensePlate: string | null;
}

export function VehicleCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [vin, setVin] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: {
      make: string;
      model: string;
      year?: string;
      vin?: string;
      licensePlate?: string;
    }) => api.post<Vehicle>(`/v1/drivers/${id ?? ''}/vehicles`, body),
    onSuccess: (created) => {
      void navigate(`/drivers/${id ?? ''}/vehicles/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!make.trim()) errors.make = t('validation.required');
    if (!model.trim()) errors.model = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: {
      make: string;
      model: string;
      year?: string;
      vin?: string;
      licensePlate?: string;
    } = { make, model };
    if (year.trim() !== '') body.year = year;
    if (vin.trim() !== '') body.vin = vin;
    if (licensePlate.trim() !== '') body.licensePlate = licensePlate;
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/drivers/${id ?? ''}?tab=vehicles`} />
        <h1 className="text-2xl font-bold md:text-3xl">{t('vehicles.createVehicle')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vehicle-make">{t('vehicles.make')}</Label>
                <Input
                  id="vehicle-make"
                  value={make}
                  onChange={(e) => {
                    setMake(e.target.value);
                  }}
                  className={hasSubmitted && errors.make ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.make && (
                  <p className="text-sm text-destructive">{errors.make}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="vehicle-model">{t('vehicles.model')}</Label>
                <Input
                  id="vehicle-model"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                  }}
                  className={hasSubmitted && errors.model ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.model && (
                  <p className="text-sm text-destructive">{errors.model}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vehicle-year">{t('vehicles.year')}</Label>
              <Input
                id="vehicle-year"
                value={year}
                onChange={(e) => {
                  setYear(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vehicle-vin">{t('vehicles.vin')}</Label>
              <Input
                id="vehicle-vin"
                value={vin}
                onChange={(e) => {
                  setVin(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vehicle-plate">{t('vehicles.licensePlate')}</Label>
              <Input
                id="vehicle-plate"
                value={licensePlate}
                onChange={(e) => {
                  setLicensePlate(e.target.value);
                }}
              />
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate(`/drivers/${id ?? ''}?tab=vehicles`);
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
