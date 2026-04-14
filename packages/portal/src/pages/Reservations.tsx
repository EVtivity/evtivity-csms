// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface Reservation {
  id: string;
  reservationId: number;
  stationOcppId: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

interface ReservationsResponse {
  data: Reservation[];
}

function statusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' | 'info' {
  switch (status) {
    case 'scheduled':
      return 'info';
    case 'active':
      return 'default';
    case 'used':
      return 'secondary';
    case 'cancelled':
      return 'destructive';
    case 'expired':
      return 'outline';
    default:
      return 'outline';
  }
}

export function Reservations(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useDriverTimezone();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [stationId, setStationId] = useState('');
  const [evseId, setEvseId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['portal-reservations'],
    queryFn: () => api.get<ReservationsResponse>('/v1/portal/reservations'),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/portal/reservations/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-reservations'] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: { stationId: string; evseId?: number; expiresAt: string }) =>
      api.post('/v1/portal/reservations', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-reservations'] });
      setShowForm(false);
      setStationId('');
      setEvseId('');
      setExpiresAt('');
      setError('');
    },
    onError: (err: unknown) => {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('reservations.createFailed'));
      } else {
        setError(t('reservations.createFailed'));
      }
    },
  });

  function handleCreate(): void {
    if (stationId.trim() === '' || expiresAt === '') return;
    setError('');
    const body: { stationId: string; evseId?: number; expiresAt: string } = {
      stationId: stationId.trim(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    if (evseId.trim() !== '') {
      body.evseId = Number(evseId);
    }
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('reservations.title')}</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowForm(!showForm);
            setError('');
          }}
        >
          {showForm ? t('common.cancel') : t('reservations.newReservation')}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{t('reservations.newReservation')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-sm font-medium" htmlFor="stationId">
                {t('reservations.stationId')}
              </label>
              <Input
                id="stationId"
                value={stationId}
                onChange={(e) => {
                  setStationId(e.target.value);
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="evseId">
                {t('reservations.evseId')} ({t('reservations.evseIdOptional')})
              </label>
              <Input
                id="evseId"
                type="number"
                min="1"
                value={evseId}
                onChange={(e) => {
                  setEvseId(e.target.value);
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="expiresAt">
                {t('reservations.expiresAt')}
              </label>
              <Input
                id="expiresAt"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => {
                  setExpiresAt(e.target.value);
                }}
              />
            </div>
            {error !== '' && <p className="text-sm text-destructive">{error}</p>}
            <Button
              className="w-full"
              disabled={createMutation.isPending || stationId.trim() === '' || expiresAt === ''}
              onClick={handleCreate}
            >
              {createMutation.isPending ? t('reservations.creating') : t('reservations.create')}
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {data != null && data.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('reservations.noReservations')}</p>
      )}

      <div className="space-y-2">
        {data?.data.map((reservation) => (
          <Card key={reservation.id}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{reservation.stationOcppId}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('reservations.expiresAt')}: {formatDate(reservation.expiresAt, timezone)}
                  </p>
                </div>
                <div className="text-right space-y-1">
                  <Badge variant={statusVariant(reservation.status)}>
                    {t(`reservations.${reservation.status}` as 'reservations.active')}
                  </Badge>
                  {(reservation.status === 'active' || reservation.status === 'scheduled') && (
                    <div>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={cancelMutation.isPending}
                        onClick={() => {
                          cancelMutation.mutate(reservation.id);
                        }}
                      >
                        {t('reservations.cancel')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
