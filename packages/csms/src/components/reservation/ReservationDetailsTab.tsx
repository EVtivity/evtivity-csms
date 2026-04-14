// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, Ban } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { DriverCombobox } from '@/components/driver-combobox';
import { StationCombobox } from '@/components/station-combobox';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';
import { reservationStatusVariant } from '@/lib/status-variants';

function getStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'active':
      return t('reservations.active');
    case 'scheduled':
      return t('reservations.scheduled');
    case 'in_use':
      return t('reservations.in_use');
    case 'used':
      return t('reservations.used');
    case 'cancelled':
      return t('reservations.cancelled');
    case 'expired':
      return t('reservations.expired');
    default:
      return status;
  }
}

interface Connector {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  status: string;
}

interface Evse {
  evseId: number;
  connectors: Connector[];
}

interface ReservationData {
  id: string;
  reservationId: number;
  stationId: string;
  stationOcppId: string;
  siteId: string | null;
  siteName: string | null;
  evseId: string | null;
  evseOcppId: number | null;
  connectorType: string | null;
  connectorMaxPowerKw: string | null;
  driverId: string | null;
  driverFirstName: string | null;
  driverLastName: string | null;
  status: string;
  startsAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  sessionStatus: string | null;
  sessionEnergyWh: string | null;
  sessionCostCents: number | null;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
}

export interface ReservationDetailsTabProps {
  reservation: ReservationData;
  timezone: string;
}

export function ReservationDetailsTab({
  reservation,
  timezone,
}: ReservationDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [editConnectorKey, setEditConnectorKey] = useState('');
  const [editStartsAt, setEditStartsAt] = useState('');
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [editDriver, setEditDriver] = useState<{ id: string; name: string } | null>(null);
  const [editSubmitted, setEditSubmitted] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignStation, setReassignStation] = useState<{ id: string; stationId: string } | null>(
    null,
  );
  const [reassignConnectorKey, setReassignConnectorKey] = useState('');

  const connectorsQuery = useQuery({
    queryKey: ['stations', reservation.stationId, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${reservation.stationId}/connectors`),
    enabled: editing,
  });

  const connectorOptions = useMemo(() => {
    if (connectorsQuery.data == null) return [];
    const options: Array<{ key: string; evseId: number; label: string }> = [];
    for (const evse of connectorsQuery.data) {
      for (const conn of evse.connectors) {
        const type = conn.connectorType ?? 'Unknown';
        const power = conn.maxPowerKw != null ? `${String(conn.maxPowerKw)} kW` : '';
        options.push({
          key: `${String(evse.evseId)}-${String(conn.connectorId)}`,
          evseId: evse.evseId,
          label: `Port ${String(evse.evseId)}-${String(conn.connectorId)}: ${type}${power ? ` (${power})` : ''}`,
        });
      }
    }
    return options;
  }, [connectorsQuery.data]);

  const editMutation = useMutation({
    mutationFn: (body: {
      driverId?: string | null;
      evseId?: number | null;
      expiresAt?: string;
      startsAt?: string;
    }) => api.patch(`/v1/reservations/${reservation.id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reservations', reservation.id] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      setEditing(false);
      setEditSubmitted(false);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.delete(`/v1/reservations/${reservation.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['reservations', reservation.id] });
      setCancelOpen(false);
    },
  });

  const reassignMutation = useMutation({
    mutationFn: (body: { newStationOcppId: string; newEvseId?: number }) =>
      api.post(`/v1/reservations/${reservation.id}/reassign`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reservations', reservation.id] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      setReassignOpen(false);
      setReassignStation(null);
      setReassignConnectorKey('');
      toast({ title: t('reservations.reassignSuccess'), variant: 'success' });
    },
    onError: (error) => {
      toast({ title: getErrorMessage(error, t), variant: 'destructive' });
    },
  });

  const reassignConnectorsQuery = useQuery({
    queryKey: ['stations', reassignStation?.id, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${reassignStation?.id ?? ''}/connectors`),
    enabled: reassignStation != null,
  });

  const reassignConnectorOptions = useMemo(() => {
    if (reassignConnectorsQuery.data == null) return [];
    const options: Array<{ key: string; evseId: number; label: string }> = [];
    for (const evse of reassignConnectorsQuery.data) {
      for (const conn of evse.connectors) {
        const type = conn.connectorType ?? 'Unknown';
        const power = conn.maxPowerKw != null ? `${String(conn.maxPowerKw)} kW` : '';
        options.push({
          key: `${String(evse.evseId)}-${String(conn.connectorId)}`,
          evseId: evse.evseId,
          label: `Port ${String(evse.evseId)}-${String(conn.connectorId)}: ${type}${power ? ` (${power})` : ''}`,
        });
      }
    }
    return options;
  }, [reassignConnectorsQuery.data]);

  function startEdit(): void {
    setEditConnectorKey(
      reservation.evseOcppId != null ? `${String(reservation.evseOcppId)}-1` : '',
    );
    setEditStartsAt(
      reservation.startsAt != null
        ? new Date(reservation.startsAt).toISOString().slice(0, 16)
        : new Date(reservation.createdAt).toISOString().slice(0, 16),
    );
    setEditExpiresAt(new Date(reservation.expiresAt).toISOString().slice(0, 16));
    setEditDriver(
      reservation.driverId != null && reservation.driverFirstName
        ? {
            id: reservation.driverId,
            name: `${reservation.driverFirstName} ${reservation.driverLastName ?? ''}`.trim(),
          }
        : null,
    );
    editMutation.reset();
    setEditSubmitted(false);
    setEditing(true);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setEditSubmitted(true);
    if (editExpiresAt.trim() === '') return;

    const body: {
      driverId?: string | null;
      evseId?: number | null;
      expiresAt?: string;
      startsAt?: string;
    } = {};

    // Connector -> EVSE ID
    const selectedOpt = connectorOptions.find((o) => o.key === editConnectorKey);
    const newEvseId = selectedOpt?.evseId ?? null;
    const originalEvseId = reservation.evseOcppId;
    if (newEvseId !== originalEvseId) {
      body.evseId = newEvseId;
    }

    // Starts At
    if (editStartsAt.trim() !== '') {
      const newStarts = new Date(editStartsAt).toISOString();
      const originalStarts =
        reservation.startsAt != null ? new Date(reservation.startsAt).toISOString() : null;
      if (newStarts !== originalStarts) {
        body.startsAt = newStarts;
      }
    }

    // Expires At
    const newExpires = new Date(editExpiresAt).toISOString();
    if (newExpires !== new Date(reservation.expiresAt).toISOString()) {
      body.expiresAt = newExpires;
    }

    // Driver
    const newDriverId = editDriver?.id ?? null;
    if (newDriverId !== reservation.driverId) {
      body.driverId = newDriverId;
    }

    editMutation.mutate(body);
  }

  const driverName =
    reservation.driverId != null && reservation.driverFirstName
      ? `${reservation.driverFirstName} ${reservation.driverLastName ?? ''}`.trim()
      : null;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          {!editing && (reservation.status === 'active' || reservation.status === 'scheduled') && (
            <div className="flex items-center gap-2">
              <EditButton label={t('common.edit')} onClick={startEdit} />
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  reassignMutation.reset();
                  setReassignStation(null);
                  setReassignConnectorKey('');
                  setReassignOpen(true);
                }}
              >
                <ArrowRightLeft className="h-4 w-4" />
                {t('reservations.reassign')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setCancelOpen(true);
                }}
              >
                <Ban className="h-4 w-4" />
                {t('reservations.cancelReservation')}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-connector-select">{t('reservations.connector')}</Label>
                {connectorOptions.length > 0 ? (
                  <Select
                    id="edit-connector-select"
                    value={editConnectorKey}
                    onChange={(e) => {
                      setEditConnectorKey(e.target.value);
                    }}
                  >
                    <option value="">{t('reservations.selectConnector')}</option>
                    {connectorOptions.map((opt) => (
                      <option key={opt.key} value={opt.key}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Select id="edit-connector-select" disabled>
                    <option value="">{t('common.loading')}</option>
                  </Select>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="editStartsAt">{t('reservations.startsAt')}</Label>
                  <Input
                    id="editStartsAt"
                    type="datetime-local"
                    value={editStartsAt}
                    onChange={(e) => {
                      setEditStartsAt(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editExpiresAt">{t('reservations.expiresAtLabel')}</Label>
                  <Input
                    id="editExpiresAt"
                    type="datetime-local"
                    value={editExpiresAt}
                    onChange={(e) => {
                      setEditExpiresAt(e.target.value);
                    }}
                    className={
                      editSubmitted && editExpiresAt.trim() === '' ? 'border-destructive' : ''
                    }
                  />
                  {editSubmitted && editExpiresAt.trim() === '' && (
                    <p className="text-sm text-destructive">{t('validation.required')}</p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('reservations.driverLabel')}</Label>
                <DriverCombobox value={editDriver} onSelect={setEditDriver} />
              </div>
              {editMutation.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(editMutation.error, t)}</p>
              )}
              <div className="flex gap-2">
                <SaveButton isPending={editMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setEditSubmitted(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('stations.site')}</dt>
                <dd className="font-medium">{reservation.siteName ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.stationLabel')}</dt>
                <dd className="font-medium">
                  <Link to={`/stations/${reservation.stationId}`} className="hover:underline">
                    {reservation.stationOcppId}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.connector')}</dt>
                <dd className="font-medium">
                  {reservation.evseOcppId != null
                    ? `Port ${String(reservation.evseOcppId)}${reservation.connectorType ? `: ${reservation.connectorType}` : ''}${reservation.connectorMaxPowerKw ? ` (${reservation.connectorMaxPowerKw} kW)` : ''}`
                    : '--'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.statusLabel')}</dt>
                <dd className="font-medium">
                  <Badge variant={reservationStatusVariant(reservation.status)}>
                    {getStatusLabel(reservation.status, t as (key: string) => string)}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.startsAt')}</dt>
                <dd className="font-medium">
                  {reservation.startsAt != null
                    ? formatDateTime(reservation.startsAt, timezone)
                    : formatDateTime(reservation.createdAt, timezone)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.expiresAtLabel')}</dt>
                <dd className="font-medium">{formatDateTime(reservation.expiresAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.driverLabel')}</dt>
                <dd className="font-medium">
                  {driverName != null ? (
                    <Link to={`/drivers/${reservation.driverId ?? ''}`} className="hover:underline">
                      {driverName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{t('reservations.noDriver')}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('reservations.createdAtLabel')}</dt>
                <dd className="font-medium">{formatDateTime(reservation.createdAt, timezone)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('reservations.cancel')}
        description={t('reservations.confirmCancel')}
        confirmLabel={t('reservations.cancel')}
        variant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          cancelMutation.mutate();
        }}
      />

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="max-w-lg overflow-visible">
          <DialogHeader>
            <DialogTitle>{t('reservations.reassignTitle')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>{t('reservations.stationLabel')}</Label>
              <StationCombobox
                value={reassignStation}
                onSelect={(s) => {
                  setReassignStation(s);
                  setReassignConnectorKey('');
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reassign-connector-select">{t('reservations.connector')}</Label>
              {reassignStation != null && reassignConnectorOptions.length > 0 ? (
                <Select
                  id="reassign-connector-select"
                  value={reassignConnectorKey}
                  onChange={(e) => {
                    setReassignConnectorKey(e.target.value);
                  }}
                >
                  <option value="">{t('reservations.selectConnector')}</option>
                  {reassignConnectorOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Select id="reassign-connector-select" disabled>
                  <option value="">
                    {reassignStation == null
                      ? t('reservations.selectStationFirst')
                      : t('common.loading')}
                  </option>
                </Select>
              )}
            </div>
            {reassignMutation.isError && (
              <p className="text-sm text-destructive">
                {getErrorMessage(reassignMutation.error, t)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReassignOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (reassignStation == null) return;
                const body: { newStationOcppId: string; newEvseId?: number } = {
                  newStationOcppId: reassignStation.stationId,
                };
                const selectedOpt = reassignConnectorOptions.find(
                  (o) => o.key === reassignConnectorKey,
                );
                if (selectedOpt != null) {
                  body.newEvseId = selectedOpt.evseId;
                }
                reassignMutation.mutate(body);
              }}
              disabled={reassignMutation.isPending || reassignStation == null}
            >
              {reassignMutation.isPending ? t('common.saving') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
