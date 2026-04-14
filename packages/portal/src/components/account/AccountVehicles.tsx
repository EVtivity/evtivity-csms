// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

interface Vehicle {
  id: string;
  make: string | null;
  model: string | null;
  year: string | null;
}

export function AccountVehicles(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');

  const { data: vehicles } = useQuery({
    queryKey: ['portal-vehicles'],
    queryFn: () => api.get<Vehicle[]>('/v1/portal/vehicles'),
  });

  const addMutation = useMutation({
    mutationFn: (body: { make: string; model: string; year?: string }) =>
      api.post<Vehicle>('/v1/portal/vehicles', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicle-efficiency'] });
      setMake('');
      setModel('');
      setYear('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/portal/vehicles/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicles'] });
      void queryClient.invalidateQueries({ queryKey: ['portal-vehicle-efficiency'] });
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('vehicles.helper')}</p>

      {vehicles != null && vehicles.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('vehicles.noVehicles')}</p>
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (make.trim() !== '' && model.trim() !== '') {
            addMutation.mutate({
              make: make.trim(),
              model: model.trim(),
              ...(year.trim() !== '' ? { year: year.trim() } : {}),
            });
          }
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-3 gap-2">
          <Input
            value={make}
            onChange={(e) => {
              setMake(e.target.value);
            }}
            placeholder={t('vehicles.make')}
          />
          <Input
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
            }}
            placeholder={t('vehicles.model')}
          />
          <Input
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
            }}
            placeholder={t('vehicles.year')}
            maxLength={4}
          />
        </div>
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
