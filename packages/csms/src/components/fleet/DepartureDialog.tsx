// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { SaveButton } from '@/components/save-button';
import { Select } from '@/components/ui/select';
import { TimeInput } from '@/components/ui/time-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { LoadingState } from '@/components/ui/content-state';
import { getErrorMessage } from '@/lib/error-message';
import { depotLocalToIso, isoToDepotLocal } from '@/lib/depot-time';
import {
  TargetFields,
  targetBody,
  targetError,
  targetMaxError,
  targetValues,
  type TargetFormValues,
} from './DepartureScheduleDialog';
import {
  fleetDepartureKeys,
  vehicleLabel,
  type Departure,
  type DepotSite,
  type FleetVehicleOption,
} from './departure-types';

const MIN_AHEAD_MS = 5 * 60_000;
const MAX_AHEAD_MS = 30 * 86_400_000;

interface DepartureDialogProps {
  fleetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The departure to edit (time, target, priority); absent for a new one-off departure. */
  departure?: Departure | null | undefined;
  vehicles: readonly FleetVehicleOption[];
  sites: readonly DepotSite[];
}

/** Add a one-off departure or change one (times are local to the depot). */
export function DepartureDialog({
  fleetId,
  open,
  onOpenChange,
  departure,
  vehicles,
  sites,
}: DepartureDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  // An edit fills its fields in the depot's time, so it waits for the zone.
  const zoneKnown =
    departure == null ||
    departure.siteTimezone != null ||
    sites.some((s) => s.id === departure.siteId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] md:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {departure != null
              ? t('fleets.departures.editDeparture')
              : t('fleets.departures.addDeparture')}
          </DialogTitle>
          <DialogDescription>{t('fleets.departures.departureDialogDescription')}</DialogDescription>
        </DialogHeader>
        {open && !zoneKnown && <LoadingState />}
        {open && zoneKnown && (
          <DepartureForm
            fleetId={fleetId}
            departure={departure ?? null}
            vehicles={vehicles}
            sites={sites}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DepartureForm({
  fleetId,
  departure,
  vehicles,
  sites,
  onDone,
}: {
  fleetId: string;
  departure: Departure | null;
  vehicles: readonly FleetVehicleOption[];
  sites: readonly DepotSite[];
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [vehicleId, setVehicleId] = useState(departure?.vehicleId ?? '');
  const [siteId, setSiteId] = useState(departure?.siteId ?? '');
  // An edit takes the zone of its row, so its fields start in the depot's time.
  const timezone = departure?.siteTimezone ?? sites.find((s) => s.id === siteId)?.timezone ?? null;
  // An ad hoc request has no time: the edit starts empty.
  const initial =
    departure?.departureAt != null
      ? isoToDepotLocal(departure.departureAt, timezone)
      : { date: '', time: '' };
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [target, setTarget] = useState<TargetFormValues>(targetValues(departure ?? undefined));
  // The expected arrival (optional), in the depot's time like the departure.
  const initialArrival =
    departure?.expectedArrivalAt != null
      ? isoToDepotLocal(departure.expectedArrivalAt, timezone)
      : { date: '', time: '' };
  const [arrivalDate, setArrivalDate] = useState(initialArrival.date);
  const [arrivalTime, setArrivalTime] = useState(initialArrival.time);
  const [arrivalSoc, setArrivalSoc] = useState(
    departure?.expectedArrivalSocPercent != null ? String(departure.expectedArrivalSocPercent) : '',
  );
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      departure != null
        ? api.patch(`/v1/departures/${departure.id}`, body)
        : api.post(`/v1/fleets/${fleetId}/departures`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fleetDepartureKeys.all(fleetId) });
      void queryClient.invalidateQueries({ queryKey: ['site-charging-plan'] });
      onDone();
    },
  });

  const departureAt = date !== '' && time !== '' ? depotLocalToIso(date, time, timezone) : null;
  const errors: Record<string, string> = {};
  if (departure == null && vehicleId === '') errors['vehicle'] = t('validation.selectRequired');
  if (departure == null && siteId === '') errors['site'] = t('validation.selectRequired');
  if (date === '' || time === '' || departureAt == null) {
    errors['when'] = t('validation.required');
  } else {
    const ahead = new Date(departureAt).getTime() - Date.now();
    if (ahead < MIN_AHEAD_MS || ahead > MAX_AHEAD_MS)
      errors['when'] = t('fleets.departures.whenRange');
  }
  const targetProblem = targetError(target, t);
  if (targetProblem != null) errors['target'] = targetProblem;
  const targetMaxProblem = targetMaxError(target, t);
  if (targetMaxProblem != null) errors['targetMax'] = targetMaxProblem;
  const arrivalGiven = arrivalDate !== '' || arrivalTime !== '';
  const arrivalAt =
    arrivalDate !== '' && arrivalTime !== ''
      ? depotLocalToIso(arrivalDate, arrivalTime, timezone)
      : null;
  if (arrivalGiven && arrivalAt == null) {
    errors['arrival'] = t('fleets.departures.arrivalIncomplete');
  } else if (arrivalAt != null && departureAt != null && arrivalAt >= departureAt) {
    errors['arrival'] = t('fleets.departures.arrivalBeforeDeparture');
  }
  const socText = arrivalSoc.trim();
  const socValue = socText === '' ? null : Number(socText);
  if (socValue != null && (!Number.isInteger(socValue) || socValue < 0 || socValue > 100)) {
    errors['arrivalSoc'] = t('fleets.departures.arrivalSocRange');
  }
  const shown = (key: string): string | null => (hasSubmitted ? (errors[key] ?? null) : null);

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0 || departureAt == null) return;
    const body: Record<string, unknown> = { departureAt, ...targetBody(target) };
    if (departure == null) {
      body['vehicleId'] = vehicleId;
      body['siteId'] = siteId;
      if (arrivalAt != null) body['expectedArrivalAt'] = arrivalAt;
      if (socValue != null) body['expectedArrivalSocPercent'] = socValue;
    } else {
      // An emptied field removes the stored value (null); an untouched empty one sends nothing.
      if (arrivalAt != null || departure.expectedArrivalAt != null) {
        body['expectedArrivalAt'] = arrivalAt;
      }
      if (socValue != null || departure.expectedArrivalSocPercent != null) {
        body['expectedArrivalSocPercent'] = socValue;
      }
    }
    mutation.mutate(body);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-4">
      {departure == null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-start">
          <div className="grid gap-2">
            <Label htmlFor="departure-vehicle">{t('fleets.departures.vehicle')}</Label>
            <Select
              id="departure-vehicle"
              value={vehicleId}
              onChange={(e) => {
                setVehicleId(e.target.value);
              }}
              className={shown('vehicle') != null ? 'border-destructive' : ''}
            >
              <option value="">{t('fleets.departures.selectVehicle')}</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {vehicleLabel(v)}
                </option>
              ))}
            </Select>
            {shown('vehicle') != null && (
              <p className="text-sm text-destructive">{shown('vehicle')}</p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="departure-site">{t('fleets.departures.depot')}</Label>
            <Select
              id="departure-site"
              value={siteId}
              onChange={(e) => {
                setSiteId(e.target.value);
              }}
              className={shown('site') != null ? 'border-destructive' : ''}
            >
              <option value="">{t('fleets.departures.selectDepot')}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            {shown('site') != null && <p className="text-sm text-destructive">{shown('site')}</p>}
          </div>
        </div>
      ) : (
        <p className="text-sm">
          {vehicleLabel(departure.vehicle)}
          {departure.siteName != null ? ` · ${departure.siteName}` : ''}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-start">
        <div className="grid gap-2">
          <Label htmlFor="departure-date">{t('fleets.departures.departureDate')}</Label>
          <DateInput
            id="departure-date"
            value={date}
            onChange={(value) => {
              setDate(value);
            }}
            invalid={shown('when') != null}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="departure-time">{t('fleets.departures.departureTime')}</Label>
          <TimeInput
            id="departure-time"
            value={time}
            onChange={setTime}
            allowEmpty={false}
            invalid={shown('when') != null}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('fleets.departures.depotTimeZone', { timezone: timezone ?? 'UTC' })}
      </p>
      {shown('when') != null && <p className="text-sm text-destructive">{shown('when')}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 items-start">
        <div className="grid gap-2">
          <Label htmlFor="departure-arrival-date">{t('fleets.departures.arrivalDate')}</Label>
          <DateInput
            id="departure-arrival-date"
            value={arrivalDate}
            onChange={(value) => {
              setArrivalDate(value);
            }}
            invalid={shown('arrival') != null}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="departure-arrival-time">{t('fleets.departures.arrivalTime')}</Label>
          <TimeInput
            id="departure-arrival-time"
            value={arrivalTime}
            onChange={setArrivalTime}
            invalid={shown('arrival') != null}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="departure-arrival-soc">{t('fleets.departures.arrivalSocPercent')}</Label>
          <Input
            id="departure-arrival-soc"
            type="number"
            inputMode="numeric"
            value={arrivalSoc}
            onChange={(e) => {
              setArrivalSoc(e.target.value);
            }}
            className={shown('arrivalSoc') != null ? 'border-destructive' : ''}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('fleets.departures.arrivalHelp')}</p>
      {shown('arrival') != null && <p className="text-sm text-destructive">{shown('arrival')}</p>}
      {shown('arrivalSoc') != null && (
        <p className="text-sm text-destructive">{shown('arrivalSoc')}</p>
      )}

      <TargetFields
        idPrefix="departure"
        values={target}
        onChange={setTarget}
        error={shown('target')}
        maxError={shown('targetMax')}
      />

      {mutation.isError && (
        <p className="text-sm text-destructive">
          {getErrorMessage(mutation.error, t, 'fleets.departures.saveFailed')}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {departure != null ? (
          <SaveButton isPending={mutation.isPending} />
        ) : (
          <CreateButton
            type="submit"
            label={t('fleets.departures.addDeparture')}
            disabled={mutation.isPending}
          />
        )}
      </DialogFooter>
    </form>
  );
}
