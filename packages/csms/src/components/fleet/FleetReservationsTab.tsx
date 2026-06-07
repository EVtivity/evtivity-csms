// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import {
  BulkReservationSlotRow,
  emptyBulkReservationSlot,
  parseSlotEvseId,
  type BulkReservationSlotState,
} from '@/components/fleet/BulkReservationSlotRow';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { fleetReservationStatusVariant } from '@/lib/status-variants';
import { InfoNote } from '@/components/ui/info-note';
import {
  getDefaultStartsAt,
  getDefaultExpiresAt,
  validateReservationDateRange,
} from '@/lib/reservation-datetime';
import { LoadingLogo } from '@/components/loading-logo';

interface FleetReservation {
  id: string;
  fleetId: string;
  name: string | null;
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  reservationCount: number;
}

interface CreateResult {
  id: string;
  status: string;
  confirmed: number;
  failed: number;
  total: number;
  results: Array<{
    stationOcppId: string;
    evseId: number | null;
    reservationId: string | null;
    status: string;
    error: string | null;
  }>;
}

interface FleetReservationsTabProps {
  fleetId: string;
}

export function FleetReservationsTab({ fleetId }: FleetReservationsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const limit = 10;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);

  // Form state. Defaults pre-fill startsAt = now + 5min (rounded to next 5-min)
  // and expiresAt = startsAt + 1h, mirroring the single-reservation create
  // form. Operators almost never want "now"; they want a tidy near-future slot.
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState(getDefaultStartsAt);
  const [expiresAt, setExpiresAt] = useState(() => getDefaultExpiresAt(getDefaultStartsAt()));
  const [slots, setSlots] = useState<BulkReservationSlotState[]>([emptyBulkReservationSlot()]);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  // System reservation policy (max-hours cap). Same source as the single
  // reservation create form so the hint and validation stay consistent.
  const policyQuery = useQuery({
    queryKey: ['reservation-policy'],
    queryFn: () => api.get<{ reservationMaxHours: number }>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  const maxHours = policyQuery.data?.reservationMaxHours ?? 0;

  const dateValidation = validateReservationDateRange({
    startsAt,
    expiresAt,
    maxHours,
    startsAtRequired: false,
  });
  const dateErrorLabel: Record<string, string> = {
    required: t('validation.required'),
    invalid: t('validation.required'),
    startsInPast: t('reservations.startsAtPastError', {
      defaultValue: 'Start time cannot be in the past',
    }),
    expiresTooSoon: t('reservations.expiresTooSoonError', {
      defaultValue: 'End time must be at least 60 seconds in the future',
    }),
    windowTooShort: t('reservations.windowTooShortError', {
      defaultValue: 'End must be at least 60 seconds after start',
    }),
    tooLong: t('reservations.tooLongError', {
      hours: maxHours,
      defaultValue: `Reservation cannot exceed ${String(maxHours)} hours`,
    }),
  };

  const { data: response, isLoading } = useQuery({
    queryKey: ['fleets', fleetId, 'reservations', page],
    queryFn: () =>
      api.get<{ data: FleetReservation[]; total: number }>(
        `/v1/fleets/${fleetId}/reservations?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = Math.max(1, Math.ceil((response?.total ?? 0) / limit));

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<CreateResult>(`/v1/fleets/${fleetId}/reservations`, body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'reservations'] });
      setDialogOpen(false);
      resetForm();
      toast({
        title: t('fleets.newBulkReservation'),
        description: `${t('fleets.slotsConfirmed', { confirmed: data.confirmed })}${data.failed > 0 ? `, ${t('fleets.slotsFailed', { failed: data.failed })}` : ''}`,
        variant: data.failed > 0 ? 'warning' : 'success',
      });
    },
    onError: (error) => {
      const message =
        error instanceof ApiError
          ? ((error.body as Record<string, string> | null)?.error ?? error.message)
          : error.message;
      toast({
        title: t('common.error'),
        description: message,
        variant: 'destructive',
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ status: string; cancelledCount: number }>(`/v1/fleet-reservations/${id}`),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'reservations'] });
      setCancelId(null);
      toast({
        title: t('fleets.cancelFleetReservation'),
        description: `${String(data.cancelledCount)} ${t('reservations.cancelled')}`,
        variant: 'success',
      });
    },
    onError: (error) => {
      const message =
        error instanceof ApiError
          ? ((error.body as Record<string, string> | null)?.error ?? error.message)
          : error.message;
      toast({
        title: t('common.error'),
        description: message,
        variant: 'destructive',
      });
    },
  });

  function resetForm(): void {
    setName('');
    const start = getDefaultStartsAt();
    setStartsAt(start);
    setExpiresAt(getDefaultExpiresAt(start));
    setSlots([emptyBulkReservationSlot()]);
    setHasSubmitted(false);
  }

  function updateSlot(index: number, next: BulkReservationSlotState): void {
    setSlots((prev) => prev.map((s, i) => (i === index ? next : s)));
  }

  function removeSlot(index: number): void {
    setSlots((prev) => prev.filter((_, i) => i !== index));
  }

  function addSlot(): void {
    setSlots((prev) => [...prev, emptyBulkReservationSlot()]);
  }

  function handleSubmit(): void {
    setHasSubmitted(true);
    if (
      dateValidation.startsAtError != null ||
      dateValidation.expiresAtError != null ||
      slots.every((s) => s.station == null)
    ) {
      return;
    }
    if (expiresAt === '') return;

    const slotPayload = slots
      .filter((s) => s.station != null)
      .map((s) => {
        const station = s.station;
        if (station == null) return null;
        const entry: Record<string, unknown> = { stationOcppId: station.stationId };
        const evseId = parseSlotEvseId(s.connectorKey);
        if (evseId != null) entry['evseId'] = evseId;
        if (s.driver != null) entry['driverId'] = s.driver.id;
        return entry;
      })
      .filter((e): e is Record<string, unknown> => e != null);

    if (slotPayload.length === 0) return;

    const body: Record<string, unknown> = {
      slots: slotPayload,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    if (name !== '') body['name'] = name;
    if (startsAt !== '') body['startsAt'] = new Date(startsAt).toISOString();

    createMutation.mutate(body);
  }

  const canCancel = (status: string): boolean => status === 'active' || status === 'partial';

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('fleets.bulkReservations')}</CardTitle>
          <Button
            onClick={() => {
              resetForm();
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('fleets.newBulkReservation')}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fleets.fleetReservationName')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('reservations.reservationCount')}</TableHead>
                  <TableHead>{t('reservations.startsAt')}</TableHead>
                  <TableHead>{t('reservations.expiresAt')}</TableHead>
                  <TableHead>{t('reservations.createdAt')}</TableHead>
                  <TableHead className="text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      <LoadingLogo size="inline" />
                    </TableCell>
                  </TableRow>
                )}
                {response?.data.map((fr) => (
                  <TableRow key={fr.id}>
                    <TableCell className="whitespace-nowrap">
                      {fr.name != null && fr.name !== '' ? fr.name : fr.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={fleetReservationStatusVariant(fr.status)}>{fr.status}</Badge>
                    </TableCell>
                    <TableCell>{fr.reservationCount}</TableCell>
                    <TableCell>
                      {fr.startsAt != null ? (
                        formatDateTime(fr.startsAt, timezone)
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </TableCell>
                    <TableCell>{formatDateTime(fr.expiresAt, timezone)}</TableCell>
                    <TableCell>{formatDateTime(fr.createdAt, timezone)}</TableCell>
                    <TableCell className="text-right">
                      {canCancel(fr.status) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('fleets.cancelFleetReservation')}
                          onClick={() => {
                            setCancelId(fr.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {response?.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      {t('reservations.noReservations')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </CardContent>
      </Card>

      {/* New Bulk Reservation Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) setDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-[95vw] md:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('fleets.newBulkReservation')}</DialogTitle>
            <DialogDescription>{t('fleets.bulkReservations')}</DialogDescription>
          </DialogHeader>

          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="fleet-reservation-name">{t('fleets.fleetReservationName')}</Label>
              <Input
                id="fleet-reservation-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                placeholder={t('fleets.fleetReservationName')}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="fleet-reservation-starts">{t('reservations.startsAt')}</Label>
                <Input
                  id="fleet-reservation-starts"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => {
                    setStartsAt(e.target.value);
                  }}
                  className={
                    hasSubmitted && dateValidation.startsAtError != null ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && dateValidation.startsAtError != null && (
                  <p className="text-sm text-destructive">
                    {dateErrorLabel[dateValidation.startsAtError]}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fleet-reservation-expires">{t('reservations.expiresAt')} *</Label>
                <Input
                  id="fleet-reservation-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => {
                    setExpiresAt(e.target.value);
                  }}
                  className={
                    hasSubmitted && dateValidation.expiresAtError != null
                      ? 'border-destructive'
                      : ''
                  }
                />
                {hasSubmitted && dateValidation.expiresAtError != null && (
                  <p className="text-sm text-destructive">
                    {dateErrorLabel[dateValidation.expiresAtError]}
                  </p>
                )}
              </div>
            </div>

            {maxHours > 0 && (
              <InfoNote>{t('reservations.maxHoursHint', { hours: maxHours })}</InfoNote>
            )}

            {/* Station slots */}
            <div className="grid gap-2">
              <Label>{t('fleets.stations')}</Label>
              <div className="grid gap-3">
                {slots.map((slot, index) => {
                  // Exclude every OTHER slot's picked station so this row's
                  // combobox can't surface it as a duplicate option.
                  const others = new Set<string>();
                  for (let j = 0; j < slots.length; j++) {
                    if (j === index) continue;
                    const id = slots[j]?.station?.id;
                    if (id != null) others.add(id);
                  }
                  return (
                    <BulkReservationSlotRow
                      key={index}
                      slot={slot}
                      onChange={(next) => {
                        updateSlot(index, next);
                      }}
                      onRemove={
                        slots.length > 1
                          ? () => {
                              removeSlot(index);
                            }
                          : null
                      }
                      excludeStationIds={others}
                    />
                  );
                })}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addSlot} className="w-fit">
                <Plus className="h-4 w-4" />
                {t('fleets.addStation')}
              </Button>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? t('common.loading') : t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        open={cancelId != null}
        onOpenChange={(open) => {
          if (!open) setCancelId(null);
        }}
        title={t('fleets.cancelFleetReservation')}
        description={t('reservations.confirmCancel')}
        confirmLabel={t('fleets.cancelFleetReservation')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          if (cancelId != null) {
            cancelMutation.mutate(cancelId);
          }
        }}
      />
    </>
  );
}
