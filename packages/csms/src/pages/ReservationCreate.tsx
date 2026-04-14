// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Info } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { DriverCombobox } from '@/components/driver-combobox';
import { StationCombobox, type StationSelection } from '@/components/station-combobox';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Reservation {
  id: string;
}

interface Connector {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  status: string;
}

interface Evse {
  evseId: number;
  status: string;
  connectors: Connector[];
}

interface Site {
  id: string;
  name: string;
}

function getEndOfDay(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}T23:59`;
}

function getCurrentDateTime(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${String(year)}-${month}-${day}T${hours}:${minutes}`;
}

export function ReservationCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [selectedStation, setSelectedStation] = useState<StationSelection | null>(null);
  const [selectedConnectorKey, setSelectedConnectorKey] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<{ id: string; name: string } | null>(null);
  const [startsAt, setStartsAt] = useState(getCurrentDateTime);
  const [expiresAt, setExpiresAt] = useState(getEndOfDay);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  // Fetch sites for the site dropdown
  const { data: sitesData } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });

  const siteOptions = sitesData?.data ?? [];

  // Reset station and connector when site changes
  useEffect(() => {
    setSelectedStation(null);
    setSelectedConnectorKey('');
  }, [selectedSiteId]);

  // Fetch EVSEs/connectors when station is selected
  const connectorsQuery = useQuery({
    queryKey: ['stations', selectedStation?.id, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${selectedStation?.id ?? ''}/connectors`),
    enabled: selectedStation != null,
  });

  // Flatten connectors with their parent EVSE ID for the dropdown
  const connectorOptions = useMemo(() => {
    if (connectorsQuery.data == null) return [];
    const options: Array<{ key: string; evseId: number; connectorId: number; label: string }> = [];
    for (const evse of connectorsQuery.data) {
      for (const conn of evse.connectors) {
        const type = conn.connectorType ?? 'Unknown';
        const power = conn.maxPowerKw != null ? `${String(conn.maxPowerKw)} kW` : '';
        const label = `Port ${String(evse.evseId)}-${String(conn.connectorId)}: ${type}${power ? ` (${power})` : ''}`;
        options.push({
          key: `${String(evse.evseId)}-${String(conn.connectorId)}`,
          evseId: evse.evseId,
          connectorId: conn.connectorId,
          label,
        });
      }
    }
    return options;
  }, [connectorsQuery.data]);

  // Reset connector selection when station changes
  useEffect(() => {
    setSelectedConnectorKey('');
  }, [selectedStation?.id]);

  const createMutation = useMutation({
    mutationFn: (body: {
      stationId: string;
      evseId?: number;
      driverId?: string;
      expiresAt: string;
      startsAt?: string;
    }) => api.post<Reservation>('/v1/reservations', body),
    onSuccess: (created) => {
      void navigate(`/reservations/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (selectedStation == null) errors.stationId = t('validation.required');
    if (expiresAt.trim() === '') errors.expiresAt = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  const isStartInFuture =
    startsAt.trim() !== '' && new Date(startsAt).getTime() > Date.now() + 60_000;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    if (selectedStation == null) return;

    const body: {
      stationId: string;
      evseId?: number;
      driverId?: string;
      expiresAt: string;
      startsAt?: string;
    } = {
      stationId: selectedStation.stationId,
      expiresAt: new Date(expiresAt).toISOString(),
    };

    if (startsAt.trim() !== '') {
      body.startsAt = new Date(startsAt).toISOString();
    }

    // Map selected connector back to EVSE ID
    const selectedOption = connectorOptions.find((o) => o.key === selectedConnectorKey);
    if (selectedOption != null) {
      body.evseId = selectedOption.evseId;
    }

    if (selectedDriver != null) {
      body.driverId = selectedDriver.id;
    }
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/reservations" />
        <h1 className="text-2xl md:text-3xl font-bold">{t('reservations.createReservation')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reservation-site-select">{t('stations.site')}</Label>
              <Select
                id="reservation-site-select"
                value={selectedSiteId}
                onChange={(e) => {
                  setSelectedSiteId(e.target.value);
                }}
              >
                <option value="">{t('reservations.allSites')}</option>
                {siteOptions.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('reservations.stationId')}</Label>
              <StationCombobox
                value={selectedStation}
                onSelect={setSelectedStation}
                siteId={selectedSiteId || undefined}
              />
              {hasSubmitted && errors.stationId && (
                <p className="text-sm text-destructive">{errors.stationId}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="reservation-connector-select">{t('reservations.connector')}</Label>
              {selectedStation != null && connectorOptions.length > 0 ? (
                <Select
                  id="reservation-connector-select"
                  value={selectedConnectorKey}
                  onChange={(e) => {
                    setSelectedConnectorKey(e.target.value);
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
                <Select id="reservation-connector-select" disabled>
                  <option value="">
                    {selectedStation == null
                      ? t('reservations.selectStationFirst')
                      : t('common.loading')}
                  </option>
                </Select>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startsAt">{t('reservations.startsAt')}</Label>
                <Input
                  id="startsAt"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => {
                    setStartsAt(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expiresAt">{t('reservations.expiresAt')}</Label>
                <Input
                  id="expiresAt"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => {
                    setExpiresAt(e.target.value);
                  }}
                  className={hasSubmitted && errors.expiresAt ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.expiresAt && (
                  <p className="text-sm text-destructive">{errors.expiresAt}</p>
                )}
              </div>
            </div>
            {isStartInFuture && (
              <p className="flex items-center gap-1 text-xs text-info">
                <Info className="h-3 w-3" />
                {t('reservations.scheduledNote')}
              </p>
            )}
            <div className="space-y-2">
              <Label>{t('reservations.driver')}</Label>
              <DriverCombobox value={selectedDriver} onSelect={setSelectedDriver} />
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/reservations');
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
