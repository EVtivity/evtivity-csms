// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorCard } from '@/components/ui/error-card';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface ReservationDetailData {
  id: string;
  reservationId: number;
  stationOcppId: string;
  siteName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  evseId: number | null;
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
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

export function ReservationDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const timezone = useDriverTimezone();
  const queryClient = useQueryClient();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const { data: reservation, isLoading } = useQuery({
    queryKey: ['portal-reservation', id],
    queryFn: () => api.get<ReservationDetailData>(`/v1/portal/reservations/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: features } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<PortalFeatures>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.delete(`/v1/portal/reservations/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-reservation', id] });
      void queryClient.invalidateQueries({ queryKey: ['portal-reservations'] });
      setShowCancelConfirm(false);
    },
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (reservation == null) {
    return <ErrorCard message={t('reservationDetail.notFound')} />;
  }

  const address = [reservation.siteAddress, reservation.siteCity, reservation.siteState]
    .filter(Boolean)
    .join(', ');

  const canCancel = reservation.status === 'active' || reservation.status === 'scheduled';

  // Cancellation fee preview: matches the API's gate in reservations.ts so the
  // user sees the same number we'd actually charge if they confirm.
  const policyFeeCents = features?.reservationCancellationFeeCents ?? 0;
  const policyWindowMinutes = features?.reservationCancellationWindowMinutes ?? 0;
  const policyActive = policyFeeCents > 0 && policyWindowMinutes > 0;
  const referenceTime = new Date(reservation.startsAt ?? reservation.createdAt).getTime();
  const minutesUntilStart = Math.floor((referenceTime - Date.now()) / 60_000);
  const cancelFeeWillApply = policyActive && canCancel && minutesUntilStart < policyWindowMinutes;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.back')}
          onClick={() => {
            void navigate(-1);
          }}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t('reservationDetail.title')}</h1>
          <CopyableId id={reservation.id} />
        </div>
        <Badge variant={statusVariant(reservation.status)}>
          {t(`reservations.${reservation.status}`)}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('reservationDetail.station')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <p className="text-sm font-medium">{reservation.stationOcppId}</p>
          {reservation.siteName != null && (
            <p className="text-sm text-muted-foreground">{reservation.siteName}</p>
          )}
          {address.length > 0 && <p className="text-xs text-muted-foreground">{address}</p>}
          {reservation.evseId != null && (
            <p className="text-xs text-muted-foreground">
              {t('reservations.connector')}: {reservation.evseId}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('reservationDetail.schedule')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {reservation.startsAt != null && (
            <Row
              label={t('reservations.startsAt')}
              value={formatDate(reservation.startsAt, timezone)}
            />
          )}
          <Row
            label={t('reservations.expiresAt')}
            value={formatDate(reservation.expiresAt, timezone)}
          />
          <Row
            label={t('reservationDetail.createdAt')}
            value={formatDate(reservation.createdAt, timezone)}
          />
        </CardContent>
      </Card>

      {policyActive && canCancel && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('reservations.cancellationPolicy')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('reservations.cancellationPolicyText', {
                fee: formatCents(policyFeeCents),
                minutes: policyWindowMinutes,
              })}
            </p>
          </CardContent>
        </Card>
      )}

      {reservation.status === 'used' && reservation.sessionId != null && (
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => {
            void navigate(`/sessions/${reservation.sessionId ?? ''}`);
          }}
        >
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-sm font-medium">{t('reservationDetail.viewSession')}</p>
              <p className="text-xs text-muted-foreground">
                {t('reservationDetail.viewSessionHint')}
              </p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </CardContent>
        </Card>
      )}

      {canCancel && (
        <Button
          variant="destructive"
          className="w-full"
          size="lg"
          disabled={cancelMutation.isPending}
          onClick={() => {
            setShowCancelConfirm(true);
          }}
        >
          {t('reservations.cancel')}
        </Button>
      )}

      <ConfirmDialog
        open={showCancelConfirm}
        onOpenChange={(open) => {
          if (!open) setShowCancelConfirm(false);
        }}
        title={t('reservations.confirmCancelTitle')}
        description={[
          reservation.status === 'scheduled' && reservation.startsAt != null
            ? t('reservations.confirmCancelScheduledDescription', {
                station: reservation.stationOcppId,
                startsTime: formatDate(reservation.startsAt, timezone),
                expiresTime: formatDate(reservation.expiresAt, timezone),
              })
            : t('reservations.confirmCancelDescription', {
                station: reservation.stationOcppId,
                time: formatDate(reservation.expiresAt, timezone),
              }),
          cancelFeeWillApply
            ? t('reservations.cancellationFeeWarning', { fee: formatCents(policyFeeCents) })
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel={t('reservations.cancel')}
        cancelLabel={t('common.keep')}
        variant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          cancelMutation.mutate();
          return false;
        }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
