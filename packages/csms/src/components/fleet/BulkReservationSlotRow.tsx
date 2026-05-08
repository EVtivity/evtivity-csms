// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { StationCombobox, type StationSelection } from '@/components/station-combobox';
import { DriverCombobox } from '@/components/driver-combobox';
import { api } from '@/lib/api';

interface Connector {
  id: string;
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
}

interface Evse {
  id: string;
  evseId: number;
  connectors: Connector[];
}

export interface BulkReservationSlotState {
  station: StationSelection | null;
  connectorKey: string;
  driver: { id: string; name: string } | null;
}

export function emptyBulkReservationSlot(): BulkReservationSlotState {
  return { station: null, connectorKey: '', driver: null };
}

interface BulkReservationSlotRowProps {
  slot: BulkReservationSlotState;
  onChange: (next: BulkReservationSlotState) => void;
  onRemove: (() => void) | null;
  excludeStationIds?: ReadonlySet<string> | undefined;
}

export function BulkReservationSlotRow({
  slot,
  onChange,
  onRemove,
  excludeStationIds,
}: BulkReservationSlotRowProps): React.JSX.Element {
  const { t } = useTranslation();

  const connectorsQuery = useQuery({
    queryKey: ['stations', slot.station?.id, 'connectors'],
    queryFn: () => api.get<Evse[]>(`/v1/stations/${slot.station?.id ?? ''}/connectors`),
    enabled: slot.station != null,
  });

  const connectorOptions = useMemo(() => {
    if (connectorsQuery.data == null) return [];
    const options: Array<{ key: string; evseId: number; connectorId: number; label: string }> = [];
    for (const evse of connectorsQuery.data) {
      for (const conn of evse.connectors) {
        const type = conn.connectorType ?? 'Unknown';
        const power = conn.maxPowerKw != null ? `${conn.maxPowerKw} kW` : '';
        const label = `Port ${String(evse.evseId)}-${String(conn.connectorId)}: ${type}${power !== '' ? ` (${power})` : ''}`;
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

  // Reset connector when station changes (or clears)
  useEffect(() => {
    if (slot.connectorKey === '') return;
    if (slot.station == null) {
      onChange({ ...slot, connectorKey: '' });
      return;
    }
    if (connectorsQuery.isSuccess && !connectorOptions.some((o) => o.key === slot.connectorKey)) {
      onChange({ ...slot, connectorKey: '' });
    }
  }, [slot.station?.id, connectorsQuery.isSuccess, slot, onChange, connectorOptions]);

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="grid gap-3 flex-1 md:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('reservations.stationId')}</Label>
            <StationCombobox
              value={slot.station}
              onSelect={(station) => {
                onChange({ ...slot, station, connectorKey: '' });
              }}
              excludeIds={excludeStationIds}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('reservations.connector')}</Label>
            {slot.station != null && connectorOptions.length > 0 ? (
              <Select
                value={slot.connectorKey}
                onChange={(e) => {
                  onChange({ ...slot, connectorKey: e.target.value });
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
              <Select disabled>
                <option value="">
                  {slot.station == null
                    ? t('reservations.selectStationFirst')
                    : t('common.loading')}
                </option>
              </Select>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('reservations.driverName')}</Label>
            <DriverCombobox
              value={slot.driver}
              onSelect={(driver) => {
                onChange({ ...slot, driver });
              }}
            />
          </div>
        </div>
        {onRemove != null && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove station"
            onClick={onRemove}
            className="mt-5"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

// Parse the connectorKey ("evseId-connectorId") back to the OCPP integer evseId.
export function parseSlotEvseId(connectorKey: string): number | null {
  if (connectorKey === '') return null;
  const [first] = connectorKey.split('-');
  if (first == null) return null;
  const n = Number(first);
  return Number.isFinite(n) ? n : null;
}
