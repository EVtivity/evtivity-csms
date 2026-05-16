// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Car, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';

const CURRENT_YEAR = new Date().getFullYear();
// Reasonable EV window: current model year + next year (manufacturers preview
// next year's models), back to 2010 (Nissan Leaf release year).
const YEAR_OPTIONS: string[] = Array.from({ length: CURRENT_YEAR + 1 - 2010 + 1 }, (_, i) =>
  String(CURRENT_YEAR + 1 - i),
);
const YEAR_REGEX = /^\d{4}$/;

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

export function AccountVehicles(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      await queryClient.invalidateQueries({ queryKey: ['portal-vehicle-efficiency'] });
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      await queryClient.invalidateQueries({ queryKey: ['portal-vehicle-efficiency'] });
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

      {/* Card list mirrors Payment Methods / RFID Cards: Car icon + name on the
          left, year badge + trash on the right. */}
      <div className="space-y-2">
        {vehicles?.map((v) => {
          const label = [v.make ?? '', v.model ?? ''].filter((s) => s !== '').join(' ');
          return (
            <Card key={v.id}>
              <CardContent className="flex items-center justify-between gap-2 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Car className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-medium">{label === '' ? '--' : label}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {v.year != null && v.year !== '' && <Badge variant="outline">{v.year}</Badge>}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-12 w-12"
                    onClick={() => {
                      setPendingDeleteId(v.id);
                    }}
                    aria-label={t('vehicles.delete')}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingDeleteId != null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
        title={t('vehicles.confirmDelete')}
        description={t('vehicles.confirmDeleteDesc')}
        confirmLabel={t('vehicles.delete')}
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingDeleteId == null) return;
          deleteMutation.mutate(pendingDeleteId, {
            onSuccess: () => {
              setPendingDeleteId(null);
            },
          });
          // Keep the dialog open until the mutation resolves; ConfirmDialog
          // closes itself on success when onConfirm doesn't return false.
          return false;
        }}
      />

      {/* Mobile-first form: each combobox + the submit button gets its own row
          on phones (where three side-by-side selects truncate the visible
          options to nothing), then collapses to a single row at sm+. */}
      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        <div className="flex flex-col gap-2 sm:grid sm:grid-cols-3">
          <Combobox
            aria-label={t('vehicles.make')}
            placeholder={t('vehicles.make')}
            value={make}
            onChange={(v) => {
              setMake(v);
              clearFeedback();
            }}
            options={lookup?.makes ?? []}
          />
          <Combobox
            aria-label={t('vehicles.model')}
            placeholder={t('vehicles.model')}
            value={model}
            onChange={(v) => {
              setModel(v);
              clearFeedback();
            }}
            options={filteredModels}
          />
          <Combobox
            aria-label={t('vehicles.year')}
            placeholder={t('vehicles.yearPlaceholder')}
            value={year}
            onChange={(v) => {
              setYear(v);
              clearFeedback();
            }}
            options={YEAR_OPTIONS}
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
