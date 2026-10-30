// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { DateTimeInput } from '@/components/ui/date-time-input';
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
import { useHasPermission } from '@/lib/auth';

/** The API accepts at most this many slots per bulk reservation. */
export const MAX_BULK_RESERVATION_SLOTS = 100;

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
  const canWrite = useHasPermission('reservations:write');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  // Per-slot outcome of a create with rejected slots, shown until dismissed.
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);

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

  const {
    data: response,
    isLoading,
    isError,
    refetch,
  } = useQuery({
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
      if (data.failed > 0) setCreateResult(data);
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
    setSlots((prev) =>
      prev.length >= MAX_BULK_RESERVATION_SLOTS ? prev : [...prev, emptyBulkReservationSlot()],
    );
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

  // A booking with a live slot can be cancelled; completed, expired and cancelled are final.
  const canCancel = (status: string): boolean =>
    status === 'scheduled' || status === 'active' || status === 'partial';
  const statusLabel = (status: string): string => {
    switch (status) {
      case 'scheduled':
        return t('fleets.bookingStatus.scheduled');
      case 'active':
        return t('fleets.bookingStatus.active');
      case 'partial':
        return t('fleets.bookingStatus.partial');
      case 'completed':
        return t('fleets.bookingStatus.completed');
      case 'expired':
        return t('fleets.bookingStatus.expired');
      case 'cancelled':
        return t('fleets.bookingStatus.cancelled');
      default:
        return status;
    }
  };

  return (
    <>
      <TabPanel
        title={t('fleets.bulkReservations')}
        actions={
          canWrite ? (
            <CreateButton
              label={t('fleets.newBulkReservation')}
              onClick={() => {
                resetForm();
                setDialogOpen(true);
              }}
            />
          ) : undefined
        }
      >
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
                <TableStateRow colSpan={7}>
                  <LoadingState />
                </TableStateRow>
              )}
              {isError && (
                <TableStateRow colSpan={7}>
                  <ErrorState
                    onRetry={() => {
                      void refetch();
                    }}
                  />
                </TableStateRow>
              )}
              {response?.data.map((fr) => (
                <TableRow key={fr.id}>
                  <TableCell className="whitespace-nowrap">
                    {fr.name != null && fr.name !== '' ? fr.name : fr.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={fleetReservationStatusVariant(fr.status)}>
                      {statusLabel(fr.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>{fr.reservationCount}</TableCell>
                  <TableCell>
                    {fr.startsAt != null ? (
                      formatDateTime(fr.startsAt, timezone)
                    ) : (
                      <span className="text-muted-foreground">{t('common.na')}</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(fr.expiresAt, timezone)}</TableCell>
                  <TableCell>{formatDateTime(fr.createdAt, timezone)}</TableCell>
                  <TableCell className="text-right">
                    {canWrite && canCancel(fr.status) && (
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
                <TableStateRow colSpan={7}>
                  <EmptyState>{t('reservations.noReservations')}</EmptyState>
                </TableStateRow>
              )}
            </TableBody>
          </Table>
        </div>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </TabPanel>

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
                <DateTimeInput
                  id="fleet-reservation-starts"
                  value={startsAt}
                  onChange={(value) => {
                    setStartsAt(value);
                  }}
                  invalid={hasSubmitted && dateValidation.startsAtError != null}
                />
                {hasSubmitted && dateValidation.startsAtError != null && (
                  <p className="text-sm text-destructive">
                    {dateErrorLabel[dateValidation.startsAtError]}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fleet-reservation-expires">{t('reservations.expiresAt')} *</Label>
                <DateTimeInput
                  id="fleet-reservation-expires"
                  value={expiresAt}
                  onChange={(value) => {
                    setExpiresAt(value);
                  }}
                  invalid={hasSubmitted && dateValidation.expiresAtError != null}
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
                  // A station can appear in several slots, but each connector
                  // only once: hide the connectors other slots picked here.
                  const others = new Set<string>();
                  for (let j = 0; j < slots.length; j++) {
                    if (j === index) continue;
                    const other = slots[j];
                    if (
                      other?.station != null &&
                      other.station.id === slot.station?.id &&
                      other.connectorKey !== ''
                    ) {
                      others.add(other.connectorKey);
                    }
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
                      excludeConnectorKeys={others}
                    />
                  );
                })}
              </div>
              <div>
                <CreateButton
                  label={t('fleets.addStation')}
                  variant="outline"
                  size="sm"
                  onClick={addSlot}
                  disabled={slots.length >= MAX_BULK_RESERVATION_SLOTS}
                />
              </div>
              {slots.length >= MAX_BULK_RESERVATION_SLOTS && (
                <p className="text-sm text-muted-foreground">
                  {t('fleets.maxSlotsReached', { max: MAX_BULK_RESERVATION_SLOTS })}
                </p>
              )}
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
              <CreateButton
                type="submit"
                disabled={createMutation.isPending}
                label={createMutation.isPending ? t('common.loading') : t('common.create')}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Per-slot result of a create with rejected slots */}
      <Dialog
        open={createResult != null}
        onOpenChange={(open) => {
          if (!open) setCreateResult(null);
        }}
      >
        <DialogContent className="max-w-[95vw] md:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('fleets.bulkResultTitle')}</DialogTitle>
            <DialogDescription>
              {createResult != null
                ? `${t('fleets.slotsConfirmed', { confirmed: createResult.confirmed })}, ${t('fleets.slotsFailed', { failed: createResult.failed })}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium">{t('fleets.bulkResultRejected')}</p>
          <ul className="grid gap-2 text-sm" data-testid="bulk-reservation-rejected">
            {createResult?.results
              .filter((r) => r.status === 'rejected')
              .map((r, i) => (
                <li key={`${r.stationOcppId}-${String(i)}`} className="rounded-md border p-2">
                  <div className="font-medium wrap-anywhere">
                    {r.stationOcppId}
                    {r.evseId != null ? ` (${t('reservations.evse')} ${String(r.evseId)})` : ''}
                  </div>
                  {r.error != null && (
                    <div className="text-muted-foreground wrap-anywhere">{r.error}</div>
                  )}
                </li>
              ))}
          </ul>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                setCreateResult(null);
              }}
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
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
