// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, X, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
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

interface SlotEntry {
  stationOcppId: string;
  evseId: string;
  driverId: string;
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

function emptySlot(): SlotEntry {
  return { stationOcppId: '', evseId: '', driverId: '' };
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

  // Form state
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [slots, setSlots] = useState<SlotEntry[]>([emptySlot()]);
  const [chargingProfile, setChargingProfile] = useState('');

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
        description: `${String(data.confirmed)} ${t('fleets.slotsConfirmed', { confirmed: data.confirmed })}${data.failed > 0 ? `, ${String(data.failed)} ${t('fleets.slotsFailed', { failed: data.failed })}` : ''}`,
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
    setExpiresAt('');
    setStartsAt('');
    setSlots([emptySlot()]);
    setChargingProfile('');
  }

  function updateSlot(index: number, field: keyof SlotEntry, value: string): void {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }

  function removeSlot(index: number): void {
    setSlots((prev) => prev.filter((_, i) => i !== index));
  }

  function addSlot(): void {
    setSlots((prev) => [...prev, emptySlot()]);
  }

  function handleSubmit(): void {
    if (expiresAt === '') return;

    const slotPayload = slots
      .filter((s) => s.stationOcppId !== '')
      .map((s) => {
        const entry: Record<string, unknown> = { stationOcppId: s.stationOcppId };
        if (s.evseId !== '') entry['evseId'] = Number(s.evseId);
        if (s.driverId !== '') entry['driverId'] = s.driverId;
        return entry;
      });

    if (slotPayload.length === 0) return;

    const body: Record<string, unknown> = {
      slots: slotPayload,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    if (name !== '') body['name'] = name;
    if (startsAt !== '') body['startsAt'] = new Date(startsAt).toISOString();
    if (chargingProfile.trim() !== '') {
      try {
        body['chargingProfile'] = JSON.parse(chargingProfile);
      } catch {
        toast({
          title: t('common.error'),
          description: 'Invalid JSON for charging profile',
          variant: 'destructive',
        });
        return;
      }
    }

    createMutation.mutate(body);
  }

  const canCancel = (status: string): boolean => status === 'active' || status === 'partial';

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
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
                  <TableHead>{t('reservations.expiresAt')}</TableHead>
                  <TableHead>{t('reservations.createdAt')}</TableHead>
                  <TableHead className="text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      {t('common.loading')}
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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
                <Label htmlFor="fleet-reservation-expires">{t('reservations.expiresAt')} *</Label>
                <Input
                  id="fleet-reservation-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => {
                    setExpiresAt(e.target.value);
                  }}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fleet-reservation-starts">{t('reservations.startsAt')}</Label>
                <Input
                  id="fleet-reservation-starts"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => {
                    setStartsAt(e.target.value);
                  }}
                />
              </div>
            </div>

            {/* Station slots */}
            <div className="grid gap-2">
              <Label>{t('fleets.stations')}</Label>
              <div className="grid gap-3">
                {slots.map((slot, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <div className="grid gap-1 flex-1">
                      <span className="text-xs text-muted-foreground">
                        {t('stations.stationId')}
                      </span>
                      <Input
                        value={slot.stationOcppId}
                        onChange={(e) => {
                          updateSlot(index, 'stationOcppId', e.target.value);
                        }}
                        placeholder="CS-0001"
                        required
                      />
                    </div>
                    <div className="grid gap-1 w-24">
                      <span className="text-xs text-muted-foreground">EVSE ID</span>
                      <Input
                        type="number"
                        min={1}
                        value={slot.evseId}
                        onChange={(e) => {
                          updateSlot(index, 'evseId', e.target.value);
                        }}
                        placeholder="1"
                      />
                    </div>
                    <div className="grid gap-1 flex-1">
                      <span className="text-xs text-muted-foreground">
                        {t('reservations.driverName')}
                      </span>
                      <Input
                        value={slot.driverId}
                        onChange={(e) => {
                          updateSlot(index, 'driverId', e.target.value);
                        }}
                        placeholder={t('fleets.selectDriver')}
                      />
                    </div>
                    {slots.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove station"
                        onClick={() => {
                          removeSlot(index);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addSlot} className="w-fit">
                <Plus className="h-4 w-4" />
                {t('fleets.addStation')}
              </Button>
            </div>

            <div className="grid gap-2">
              <Label>{t('fleets.chargingProfileJson')}</Label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={chargingProfile}
                onChange={(e) => {
                  setChargingProfile(e.target.value);
                }}
                placeholder='{"chargingProfilePurpose": "TxProfile", ...}'
              />
              <p className="text-xs text-muted-foreground">{t('fleets.chargingProfileHelp')}</p>
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
