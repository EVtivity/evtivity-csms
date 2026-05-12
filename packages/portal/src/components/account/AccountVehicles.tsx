// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';

interface Vehicle {
  id: string;
  make: string | null;
  model: string | null;
  year: string | null;
}

interface VehicleLookup {
  makes: string[];
  models: { make: string; model: string }[];
}

const YEAR_REGEX = /^\d{4}$/;

export function AccountVehicles(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: vehicles } = useQuery({
    queryKey: ['portal-vehicles'],
    queryFn: () => api.get<Vehicle[]>('/v1/portal/vehicles'),
  });

  const { data: lookup } = useQuery({
    queryKey: ['portal-vehicle-lookup'],
    queryFn: () => api.get<VehicleLookup>('/v1/portal/vehicles/lookup'),
    staleTime: 5 * 60 * 1000,
  });

  const filteredModels = useMemo(() => {
    if (lookup == null) return [];
    const trimmed = make.trim().toLowerCase();
    if (trimmed === '') return lookup.models.map((m) => m.model);
    return lookup.models.filter((m) => m.make.toLowerCase() === trimmed).map((m) => m.model);
  }, [lookup, make]);

  const yearError = year.trim() !== '' && !YEAR_REGEX.test(year.trim());

  const addMutation = useMutation({
    mutationFn: (body: { make: string; model: string; year?: string }) =>
      api.post<Vehicle>('/v1/portal/vehicles', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicle-efficiency'] });
      setMake('');
      setModel('');
      setYear('');
      setHasSubmitted(false);
      setSubmitError(null);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const body = error.body as { code?: string } | null;
        if (body?.code === 'VALIDATION_ERROR' && yearError) {
          setSubmitError(t('vehicles.yearFormat'));
          return;
        }
      }
      setSubmitError(t('vehicles.addFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/portal/vehicles/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicle-efficiency'] });
    },
  });

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    setSubmitError(null);
    if (make.trim() === '' || model.trim() === '') return;
    if (yearError) return;
    addMutation.mutate({
      make: make.trim(),
      model: model.trim(),
      ...(year.trim() !== '' ? { year: year.trim() } : {}),
    });
  }

  function clearFeedback(): void {
    if (submitError != null) setSubmitError(null);
    if (addMutation.isError) addMutation.reset();
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('vehicles.helper')}</p>

      {vehicles != null && vehicles.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">{t('vehicles.noVehicles')}</p>
      )}

      <div className="space-y-2">
        {vehicles?.map((v) => (
          <div key={v.id} className="flex items-center justify-between">
            <span className="text-sm">
              {v.make ?? ''} {v.model ?? ''} {v.year != null ? `(${v.year})` : ''}
            </span>
            <button
              onClick={() => {
                deleteMutation.mutate(v.id);
              }}
              className="text-muted-foreground hover:text-destructive transition-colors"
              aria-label={t('vehicles.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        <datalist id="vehicle-make-options">
          {lookup?.makes.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <datalist id="vehicle-model-options">
          {filteredModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <div className="grid grid-cols-3 gap-2">
          <Input
            value={make}
            onChange={(e) => {
              setMake(e.target.value);
              clearFeedback();
            }}
            placeholder={t('vehicles.make')}
            list="vehicle-make-options"
            autoComplete="off"
          />
          <Input
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              clearFeedback();
            }}
            placeholder={t('vehicles.model')}
            list="vehicle-model-options"
            autoComplete="off"
          />
          <Input
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              clearFeedback();
            }}
            placeholder={t('vehicles.yearPlaceholder')}
            inputMode="numeric"
            maxLength={4}
            className={hasSubmitted && yearError ? 'border-destructive' : ''}
          />
        </div>

        {hasSubmitted && yearError && (
          <p className="text-sm text-destructive">{t('vehicles.yearFormat')}</p>
        )}
        {submitError != null && <p className="text-sm text-destructive">{submitError}</p>}

        <Button
          type="submit"
          className="w-full"
          disabled={addMutation.isPending || make.trim() === '' || model.trim() === ''}
        >
          {t('vehicles.addVehicle')}
        </Button>
      </form>
    </div>
  );
}
