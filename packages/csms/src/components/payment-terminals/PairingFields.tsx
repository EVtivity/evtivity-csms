// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { StationCombobox } from '@/components/station-combobox';
import { api } from '@/lib/api';

/**
 * One EVSE of `GET /v1/stations/:id/connectors`. `id` is the internal EVSE ID
 * the pairing routes take; an EVSE without it cannot be chosen.
 */
interface EvseOption {
  id?: string;
  evseId: number;
  retiredAt?: string | null;
}

/** The value of a pairing: a station and one connector, or the whole station (`evseId` ''). */
export interface PairingValue {
  stationId: string;
  evseId: string;
}

export const NO_PAIRING: PairingValue = { stationId: '', evseId: '' };

/**
 * The OCPP identity of a station named by its internal ID (a deep link or a
 * stored pairing), so the station field shows it whatever page of the
 * station list it is on. Same query as the station page.
 */
export function useStationIdentity(stationId: string): string | null {
  const { data } = useQuery({
    queryKey: ['stations', stationId],
    queryFn: () => api.get<{ id: string; stationId: string }>(`/v1/stations/${stationId}`),
    enabled: stationId !== '',
  });
  return data?.stationId ?? null;
}

/** The EVSEs of a station that can be paired (internal ID known, not retired). */
export function useStationEvseOptions(stationId: string): {
  evses: { id: string; evseId: number }[];
} {
  const { data } = useQuery({
    queryKey: ['stations', stationId, 'connectors'],
    queryFn: () => api.get<EvseOption[]>(`/v1/stations/${stationId}/connectors`),
    enabled: stationId !== '',
  });
  const evses = (data ?? [])
    .filter(
      (e): e is EvseOption & { id: string } => typeof e.id === 'string' && e.retiredAt == null,
    )
    .map((e) => ({ id: e.id, evseId: e.evseId }));
  return { evses };
}

interface PairingFieldsProps {
  idPrefix: string;
  value: PairingValue;
  onChange: (value: PairingValue) => void;
  /** A fixed station (the station page): only the connector is chosen. */
  fixedStationId?: string;
  stationError?: string | undefined;
}

/**
 * The station and connector of a pairing. "Whole Station" pairs the terminal
 * to every connector: the driver picks the connector on the terminal screen,
 * or plugs in at any connector for a terminal without a screen (VP7200).
 */
export function PairingFields({
  idPrefix,
  value,
  onChange,
  fixedStationId,
  stationError,
}: PairingFieldsProps): React.JSX.Element {
  const { t } = useTranslation();
  const stationId = fixedStationId ?? value.stationId;
  // The search answers stations of the caller's sites only (the station list scope).
  const identity = useStationIdentity(fixedStationId == null ? value.stationId : '');
  const [picked, setPicked] = useState<{ id: string; stationId: string } | null>(null);
  const shownIdentity =
    identity ?? (picked?.id === value.stationId ? picked.stationId : value.stationId);
  const { evses } = useStationEvseOptions(stationId);

  return (
    <div className="space-y-4">
      {fixedStationId == null && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-station`} className="leading-6">
            {t('paymentTerminals.pairing.station')}
          </Label>
          <StationCombobox
            id={`${idPrefix}-station`}
            invalid={stationError != null}
            value={
              value.stationId === '' ? null : { id: value.stationId, stationId: shownIdentity }
            }
            onSelect={(station) => {
              setPicked(station);
              onChange({ stationId: station?.id ?? '', evseId: '' });
            }}
          />
          {stationError != null && <p className="text-sm text-destructive">{stationError}</p>}
        </div>
      )}
      {stationId !== '' && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-connector`} className="leading-6">
            {t('paymentTerminals.pairing.connector')}
          </Label>
          <Select
            id={`${idPrefix}-connector`}
            value={value.evseId}
            onChange={(e) => {
              onChange({ stationId, evseId: e.target.value });
            }}
          >
            <option value="">{t('paymentTerminals.wholeStation')}</option>
            {evses.map((e) => (
              <option key={e.id} value={e.id}>
                {t('paymentTerminals.connector', { number: e.evseId })}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('paymentTerminals.pairing.wholeStationHint')}
          </p>
        </div>
      )}
    </div>
  );
}
