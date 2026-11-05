// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveButton } from '@/components/save-button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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
import { getErrorMessage } from '@/lib/error-message';
import { isoWeekdayNames } from '@/lib/depot-time';
import {
  fleetDepartureKeys,
  vehicleLabel,
  type DepartureSchedule,
  type DepartureTargetKind,
  type DepotSite,
  type FleetVehicleOption,
} from './departure-types';

/** The target and priority a departure or a schedule holds, as the form edits them. */
export interface TargetFormValues {
  targetKind: DepartureTargetKind;
  /** The kWh or percent as typed. */
  targetValue: string;
  /** "Up To": the maximum state of charge as typed (soc targets), '' for none. */
  targetMaxValue: string;
  priority: string;
}

export const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** The validation error of the target, or null. */
export function targetError(values: TargetFormValues, t: TFunction): string | null {
  const value = Number(values.targetValue);
  if (values.targetValue.trim() === '' || !Number.isFinite(value)) return t('validation.required');
  if (values.targetKind === 'energy' && (value < 0.1 || value > 2000)) {
    return t('fleets.departures.energyRange');
  }
  if (values.targetKind === 'soc' && (!Number.isInteger(value) || value < 1 || value > 100)) {
    return t('fleets.departures.socRange');
  }
  return null;
}

/** The validation error of the "Up To" state of charge, or null (soc targets only). */
export function targetMaxError(values: TargetFormValues, t: TFunction): string | null {
  if (values.targetKind !== 'soc' || values.targetMaxValue.trim() === '') return null;
  const max = Number(values.targetMaxValue);
  const min = Number(values.targetValue);
  if (!Number.isInteger(max) || max < 1 || max > 100) return t('fleets.departures.socRange');
  if (Number.isFinite(min) && max < min) return t('fleets.departures.upToBelowTarget');
  return null;
}

/** The target fields of a request body. */
export function targetBody(values: TargetFormValues): Record<string, unknown> {
  const value = Number(values.targetValue);
  const max = values.targetMaxValue.trim();
  return {
    targetKind: values.targetKind,
    ...(values.targetKind === 'energy'
      ? { targetEnergyKwh: value }
      : { targetSocPercent: value, targetSocMaxPercent: max === '' ? null : Number(max) }),
    priority: Number(values.priority),
  };
}

export function targetValues(source?: {
  targetKind: DepartureTargetKind;
  targetEnergyKwh: number | null;
  targetSocPercent: number | null;
  targetSocMaxPercent?: number | null;
  priority: number;
}): TargetFormValues {
  if (source == null) {
    return { targetKind: 'energy', targetValue: '', targetMaxValue: '', priority: '5' };
  }
  return {
    targetKind: source.targetKind,
    targetValue: String(
      source.targetKind === 'energy'
        ? (source.targetEnergyKwh ?? '')
        : (source.targetSocPercent ?? ''),
    ),
    targetMaxValue:
      source.targetKind === 'soc' && source.targetSocMaxPercent != null
        ? String(source.targetSocMaxPercent)
        : '',
    priority: String(source.priority),
  };
}

interface TargetFieldsProps {
  idPrefix: string;
  values: TargetFormValues;
  onChange: (values: TargetFormValues) => void;
  error: string | null;
  /** The error of the "Up To" field, shown for soc targets. */
  maxError?: string | null | undefined;
}

/** Target kind, target value, "Up To" and priority, shared by the schedule and departure dialogs. */
export function TargetFields({
  idPrefix,
  values,
  onChange,
  error,
  maxError = null,
}: TargetFieldsProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 items-start">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-target-kind`}>{t('fleets.departures.targetKind')}</Label>
        <Select
          id={`${idPrefix}-target-kind`}
          value={values.targetKind}
          onChange={(e) => {
            onChange({ ...values, targetKind: e.target.value as DepartureTargetKind });
          }}
        >
          <option value="energy">{t('fleets.departures.targetEnergy')}</option>
          <option value="soc">{t('fleets.departures.targetSoc')}</option>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-target-value`}>
          {values.targetKind === 'energy'
            ? t('fleets.departures.energyKwh')
            : t('fleets.departures.socPercent')}
        </Label>
        <Input
          id={`${idPrefix}-target-value`}
          type="number"
          inputMode="decimal"
          value={values.targetValue}
          onChange={(e) => {
            onChange({ ...values, targetValue: e.target.value });
          }}
          className={error != null ? 'border-destructive' : ''}
        />
        {error != null && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-priority`}>{t('fleets.departures.priority')}</Label>
        <Select
          id={`${idPrefix}-priority`}
          value={values.priority}
          onChange={(e) => {
            onChange({ ...values, priority: e.target.value });
          }}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={String(p)}>
              {String(p)}
            </option>
          ))}
        </Select>
      </div>
      {values.targetKind === 'soc' && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-target-max`}>{t('fleets.departures.upToPercent')}</Label>
          <Input
            id={`${idPrefix}-target-max`}
            type="number"
            inputMode="numeric"
            value={values.targetMaxValue}
            onChange={(e) => {
              onChange({ ...values, targetMaxValue: e.target.value });
            }}
            className={maxError != null ? 'border-destructive' : ''}
          />
          <p className="text-xs text-muted-foreground">{t('fleets.departures.upToHelp')}</p>
          {maxError != null && <p className="text-sm text-destructive">{maxError}</p>}
        </div>
      )}
    </div>
  );
}

interface DepartureScheduleDialogProps {
  fleetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule to edit; absent for a new one. */
  schedule?: DepartureSchedule | null | undefined;
  vehicles: readonly FleetVehicleOption[];
  sites: readonly DepotSite[];
}

/** Add or edit a weekly departure schedule (times are local to the depot). */
export function DepartureScheduleDialog({
  fleetId,
  open,
  onOpenChange,
  schedule,
  vehicles,
  sites,
}: DepartureScheduleDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] md:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {schedule != null
              ? t('fleets.departures.editSchedule')
              : t('fleets.departures.addSchedule')}
          </DialogTitle>
          <DialogDescription>{t('fleets.departures.scheduleDialogDescription')}</DialogDescription>
        </DialogHeader>
        {open && (
          <ScheduleForm
            fleetId={fleetId}
            schedule={schedule ?? null}
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

function ScheduleForm({
  fleetId,
  schedule,
  vehicles,
  sites,
  onDone,
}: {
  fleetId: string;
  schedule: DepartureSchedule | null;
  vehicles: readonly FleetVehicleOption[];
  sites: readonly DepotSite[];
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const editing = schedule != null;
  const [vehicleId, setVehicleId] = useState(schedule?.vehicleId ?? '');
  const [siteId, setSiteId] = useState(schedule?.siteId ?? '');
  const [days, setDays] = useState<number[]>(schedule?.daysOfWeek ?? [1, 2, 3, 4, 5]);
  const [time, setTime] = useState(schedule?.departureTime ?? '');
  const [target, setTarget] = useState<TargetFormValues>(targetValues(schedule ?? undefined));
  const [validFrom, setValidFrom] = useState(schedule?.validFrom ?? '');
  const [validTo, setValidTo] = useState(schedule?.validTo ?? '');
  const [isActive, setIsActive] = useState(schedule?.isActive ?? true);
  const [notes, setNotes] = useState(schedule?.notes ?? '');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const weekdays = isoWeekdayNames();

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      schedule != null
        ? api.patch(`/v1/departure-schedules/${schedule.id}`, body)
        : api.post(`/v1/fleets/${fleetId}/departure-schedules`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fleetDepartureKeys.all(fleetId) });
      onDone();
    },
  });

  const errors: Record<string, string> = {};
  if (!editing && vehicleId === '') errors['vehicle'] = t('validation.selectRequired');
  if (siteId === '') errors['site'] = t('validation.selectRequired');
  if (days.length === 0) errors['days'] = t('fleets.departures.daysRequired');
  if (time === '') errors['time'] = t('validation.required');
  const targetProblem = targetError(target, t);
  const targetMaxProblem = targetMaxError(target, t);
  if (targetMaxProblem != null) errors['targetMax'] = targetMaxProblem;
  if (targetProblem != null) errors['target'] = targetProblem;
  if (validFrom !== '' && validTo !== '' && validFrom > validTo) {
    errors['validTo'] = t('fleets.departures.validRange');
  }
  const shown = (key: string): string | null => (hasSubmitted ? (errors[key] ?? null) : null);

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, unknown> = {
      siteId,
      daysOfWeek: [...days].sort((a, b) => a - b),
      departureTime: time,
      validFrom: validFrom === '' ? null : validFrom,
      validTo: validTo === '' ? null : validTo,
      notes: notes.trim() === '' ? null : notes.trim(),
      ...targetBody(target),
    };
    if (editing) body['isActive'] = isActive;
    else body['vehicleId'] = vehicleId;
    mutation.mutate(body);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-start">
        <div className="grid gap-2">
          <Label htmlFor="schedule-vehicle">{t('fleets.departures.vehicle')}</Label>
          <Select
            id="schedule-vehicle"
            value={vehicleId}
            disabled={editing}
            onChange={(e) => {
              setVehicleId(e.target.value);
            }}
            className={shown('vehicle') != null ? 'border-destructive' : ''}
          >
            <option value="">{t('fleets.departures.selectVehicle')}</option>
            {schedule?.vehicle != null && !vehicles.some((v) => v.id === vehicleId) && (
              <option value={vehicleId}>{vehicleLabel(schedule.vehicle)}</option>
            )}
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
          <Label htmlFor="schedule-site">{t('fleets.departures.depot')}</Label>
          <Select
            id="schedule-site"
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

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">{t('fleets.departures.days')}</legend>
        <div className="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap sm:gap-4 items-start">
          {weekdays.map((name, index) => {
            const day = index + 1;
            return (
              <div key={day} className="flex items-center gap-2">
                <Checkbox
                  id={`schedule-day-${String(day)}`}
                  checked={days.includes(day)}
                  onChange={(e) => {
                    setDays((prev) =>
                      e.target.checked ? [...prev, day] : prev.filter((d) => d !== day),
                    );
                  }}
                />
                <Label htmlFor={`schedule-day-${String(day)}`}>{name}</Label>
              </div>
            );
          })}
        </div>
        {shown('days') != null && <p className="text-sm text-destructive">{shown('days')}</p>}
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor="schedule-time">{t('fleets.departures.departureTime')}</Label>
        <TimeInput
          id="schedule-time"
          value={time}
          onChange={setTime}
          allowEmpty={false}
          invalid={shown('time') != null}
        />
        <p className="text-xs text-muted-foreground">{t('fleets.departures.depotTimeHelp')}</p>
        {shown('time') != null && <p className="text-sm text-destructive">{shown('time')}</p>}
      </div>

      <TargetFields
        idPrefix="schedule"
        values={target}
        onChange={setTarget}
        error={shown('target')}
        maxError={shown('targetMax')}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-start">
        <div className="grid gap-2">
          <Label htmlFor="schedule-valid-from">{t('fleets.departures.validFrom')}</Label>
          <Input
            id="schedule-valid-from"
            type="date"
            value={validFrom}
            onChange={(e) => {
              setValidFrom(e.target.value);
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="schedule-valid-to">{t('fleets.departures.validTo')}</Label>
          <Input
            id="schedule-valid-to"
            type="date"
            value={validTo}
            onChange={(e) => {
              setValidTo(e.target.value);
            }}
            className={shown('validTo') != null ? 'border-destructive' : ''}
          />
          {shown('validTo') != null && (
            <p className="text-sm text-destructive">{shown('validTo')}</p>
          )}
        </div>
      </div>

      {editing && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="schedule-active"
            checked={isActive}
            onChange={(e) => {
              setIsActive(e.target.checked);
            }}
          />
          <Label htmlFor="schedule-active">{t('fleets.departures.scheduleActive')}</Label>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="schedule-notes">{t('fleets.departures.notes')}</Label>
        <Textarea
          id="schedule-notes"
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value.slice(0, 500));
          }}
        />
      </div>

      {mutation.isError && (
        <p className="text-sm text-destructive">
          {getErrorMessage(mutation.error, t, 'fleets.departures.saveFailed')}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {editing ? (
          <SaveButton isPending={mutation.isPending} />
        ) : (
          <CreateButton
            type="submit"
            label={t('fleets.departures.addSchedule')}
            disabled={mutation.isPending}
          />
        )}
      </DialogFooter>
    </form>
  );
}
