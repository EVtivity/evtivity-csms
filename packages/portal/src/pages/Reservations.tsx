// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface Reservation {
  id: string;
  reservationId: number;
  stationOcppId: string;
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
}

interface ReservationsResponse {
  data: Reservation[];
}

interface PortalFeatures {
  reservationEnabled: boolean;
  supportEnabled: boolean;
  reservationCancellationFeeCents: number;
  reservationCancellationWindowMinutes: number;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
  const navigate = useNavigate();
  const timezone = useDriverTimezone();
  const queryClient = useQueryClient();
  // Holds the reservation pending cancel confirmation; null means dialog
  // closed. Storing the whole reservation rather than just id so the dialog
  // can render the station/time in the body without a re-lookup.
  const [pendingCancel, setPendingCancel] = useState<Reservation | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['portal-reservations'],
    queryFn: () => api.get<ReservationsResponse>('/v1/portal/reservations'),
  });

  // Cancellation policy lives on /v1/portal/features so the cancel dialog can
  // warn the holder about a potential fee before they confirm.
  const { data: features } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<PortalFeatures>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });

  function feeWillApply(reservation: Reservation): boolean {
    if (features == null) return false;
    if (features.reservationCancellationFeeCents <= 0) return false;
    if (features.reservationCancellationWindowMinutes <= 0) return false;
    const referenceTime = new Date(reservation.startsAt ?? reservation.createdAt).getTime();
    const minutesUntilStart = Math.floor((referenceTime - Date.now()) / 60_000);
    return minutesUntilStart < features.reservationCancellationWindowMinutes;
  }

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/portal/reservations/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-reservations'] });
      setPendingCancel(null);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('reservations.title')}</h1>
        <Button
          size="sm"
          onClick={() => {
            void navigate('/reservations/new');
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t('reservations.newReservation')}
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {data != null && data.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('reservations.noReservations')}</p>
      )}

      <div className="space-y-2">
        {data?.data.map((reservation) => (
          <Card
            key={reservation.id}
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => {
              void navigate(`/reservations/${reservation.id}`);
            }}
          >
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{reservation.stationOcppId}</p>
                  {reservation.startsAt != null && (
                    <p className="text-xs text-muted-foreground">
                      {t('reservations.startsAt')}: {formatDate(reservation.startsAt, timezone)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('reservations.expiresAt')}: {formatDate(reservation.expiresAt, timezone)}
                  </p>
                </div>
                <div className="text-right space-y-1 shrink-0">
                  <Badge variant={statusVariant(reservation.status)}>
                    {t(`reservations.${reservation.status}`)}
                  </Badge>
                  {(reservation.status === 'active' || reservation.status === 'scheduled') && (
                    <div>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={cancelMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingCancel(reservation);
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

      <ConfirmDialog
        open={pendingCancel != null}
        onOpenChange={(open) => {
          if (!open) setPendingCancel(null);
        }}
        title={t('reservations.confirmCancelTitle')}
        description={
          pendingCancel != null
            ? [
                pendingCancel.status === 'scheduled' && pendingCancel.startsAt != null
                  ? t('reservations.confirmCancelScheduledDescription', {
                      station: pendingCancel.stationOcppId,
                      startsTime: formatDate(pendingCancel.startsAt, timezone),
                      expiresTime: formatDate(pendingCancel.expiresAt, timezone),
                    })
                  : t('reservations.confirmCancelDescription', {
                      station: pendingCancel.stationOcppId,
                      time: formatDate(pendingCancel.expiresAt, timezone),
                    }),
                feeWillApply(pendingCancel) && features != null
                  ? t('reservations.cancellationFeeWarning', {
                      fee: formatCents(features.reservationCancellationFeeCents),
                    })
                  : '',
              ]
                .filter(Boolean)
                .join(' ')
            : ''
        }
        confirmLabel={t('reservations.cancel')}
        cancelLabel={t('common.keep')}
        variant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          if (pendingCancel != null) {
            cancelMutation.mutate(pendingCancel.id);
          }
          // Returning false keeps the dialog open until onSuccess closes it
          // -- prevents a flash where the dialog closes before the button's
          // pending spinner is visible.
          return false;
        }}
      />
    </div>
  );
}
