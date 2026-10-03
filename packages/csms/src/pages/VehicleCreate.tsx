// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { Card, CardContent } from '@/components/ui/card';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface VehicleLookup {
  makes: string[];
  models: { make: string; model: string }[];
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS: string[] = Array.from({ length: CURRENT_YEAR + 1 - 2010 + 1 }, (_, i) =>
  String(CURRENT_YEAR + 1 - i),
);

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
  const queryClient = useQueryClient();

  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [vin, setVin] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

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

  const createMutation = useMutation({
    mutationFn: (body: {
      make: string;
      model: string;
      year?: string;
      vin?: string;
      licensePlate?: string;
    }) => api.post<Vehicle>(`/v1/drivers/${id ?? ''}/vehicles`, body),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id ?? '', 'vehicles'] });
      void navigate(`/drivers/${id ?? ''}/vehicles/${created.id}`);
    },
  });

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
    return errors;
  }

  const errors = { ...getValidationErrors(), ...getApiErrorFieldDetails(createMutation.error) };

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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vehicle-make" className="leading-6">
                  {t('vehicles.make')}
                </Label>
                <Combobox
                  id="vehicle-make"
                  value={make}
                  onChange={setMake}
                  options={lookup?.makes ?? []}
                  className={hasSubmitted && errors.make ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.make && (
                  <p className="text-sm text-destructive">{errors.make}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="vehicle-model" className="leading-6">
                  {t('vehicles.model')}
                </Label>
                <Combobox
                  id="vehicle-model"
                  value={model}
                  onChange={setModel}
                  options={filteredModels}
                  className={hasSubmitted && errors.model ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.model && (
                  <p className="text-sm text-destructive">{errors.model}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="vehicle-year" className="leading-6">
                  {t('vehicles.year')}
                </Label>
                <Combobox
                  id="vehicle-year"
                  value={year}
                  onChange={setYear}
                  options={YEAR_OPTIONS}
                  inputMode="numeric"
                  maxLength={4}
                  className={hasSubmitted && errors.year ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.year && (
                  <p className="text-sm text-destructive">{errors.year}</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vehicle-vin" className="leading-6">
                  {t('vehicles.vin')}
                </Label>
                <Input
                  id="vehicle-vin"
                  value={vin}
                  onChange={(e) => {
                    setVin(e.target.value);
                  }}
                  maxLength={17}
                  className={hasSubmitted && errors.vin ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.vin && (
                  <p className="text-sm text-destructive">{errors.vin}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="vehicle-plate" className="leading-6">
                  {t('vehicles.licensePlate')}
                </Label>
                <Input
                  id="vehicle-plate"
                  value={licensePlate}
                  onChange={(e) => {
                    setLicensePlate(e.target.value);
                  }}
                />
              </div>
            </div>
            {createMutation.isError && Object.keys(errors).length === 0 && (
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
