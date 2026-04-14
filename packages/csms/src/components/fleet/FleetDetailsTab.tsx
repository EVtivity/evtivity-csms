// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EnergyChart } from '@/components/charts/EnergyChart';
import { api } from '@/lib/api';
import { formatEnergy, formatDurationMinutes } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface Fleet {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FleetMetrics {
  totalSessions: number;
  completedSessions: number;
  faultedSessions: number;
  sessionSuccessPercent: number;
  totalEnergyWh: number;
  avgSessionDurationMinutes: number;
  activeDrivers: number;
  totalDrivers: number;
  totalVehicles: number;
  periodMonths: number;
}

interface FleetDetailsTabProps {
  fleetId: string;
  fleet: Fleet;
}

export function FleetDetailsTab({ fleetId, fleet }: FleetDetailsTabProps): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: metrics } = useQuery({
    queryKey: ['fleets', fleetId, 'metrics'],
    queryFn: () => api.get<FleetMetrics>(`/v1/fleets/${fleetId}/metrics`),
    refetchInterval: 60_000,
  });

  const { data: energyData } = useQuery({
    queryKey: ['fleets', fleetId, 'energy-history'],
    queryFn: () =>
      api.get<{ date: string; energyWh: number }[]>(`/v1/fleets/${fleetId}/energy-history?days=7`),
  });

  const { data: driversResponse } = useQuery({
    queryKey: ['fleets', fleetId, 'drivers', 1],
    queryFn: () =>
      api.get<{ data: unknown[]; total: number }>(`/v1/fleets/${fleetId}/drivers?page=1&limit=1`),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; description?: string }) =>
      api.patch<Fleet>(`/v1/fleets/${fleetId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId] });
      void queryClient.invalidateQueries({ queryKey: ['fleets'] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<Fleet>(`/v1/fleets/${fleetId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleets'] });
      void navigate('/fleets');
    },
  });

  function startEdit(): void {
    setName(fleet.name);
    setDescription(fleet.description ?? '');
    setHasSubmitted(false);
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (name.trim() === '') {
      errors.name = t('validation.required');
    }
    return errors;
  }

  const errors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    updateMutation.mutate({ name, description });
  }

  const driverCount = driversResponse?.total ?? 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            <div title={driverCount > 0 ? t('fleets.removeDriversFirst') : undefined}>
              <RemoveButton
                label={t('common.delete')}
                onClick={() => {
                  deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending || driverCount > 0}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">{t('common.name')}</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  className={hasSubmitted && errors.name ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.name && (
                  <p className="text-sm text-destructive">{errors.name}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-desc">{t('common.description')}</Label>
                <textarea
                  id="edit-desc"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                  }}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('common.name')}</dt>
                <dd className="font-medium">{fleet.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.description')}</dt>
                <dd className="font-medium">{fleet.description ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(fleet.createdAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(fleet.updatedAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('fleets.totalDrivers')}</dt>
                <dd className="font-medium">{driverCount}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      {metrics != null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('fleets.fleetDetail')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('fleets.totalSessions')}</p>
                <p className="text-2xl font-bold">{String(metrics.totalSessions)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('fleets.totalEnergy')}</p>
                <p className="text-2xl font-bold">{formatEnergy(metrics.totalEnergyWh)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('fleets.avgSessionDuration')}</p>
                <p className="text-2xl font-bold">
                  {formatDurationMinutes(metrics.avgSessionDurationMinutes)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('fleets.activeDrivers')}</p>
                <p className="text-2xl font-bold">{String(metrics.activeDrivers)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('fleets.sessionSuccess')}</p>
                <p className="text-2xl font-bold">{String(metrics.sessionSuccessPercent)}%</p>
                <p className="text-xs text-muted-foreground">
                  {String(metrics.completedSessions)}/{String(metrics.totalSessions)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t('fleets.totalVehicles')}</p>
                <p className="text-2xl font-bold">{String(metrics.totalVehicles)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {energyData != null && energyData.length > 0 && <EnergyChart data={energyData} />}
    </div>
  );
}
