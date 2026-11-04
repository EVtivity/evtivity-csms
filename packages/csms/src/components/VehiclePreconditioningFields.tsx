// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The preconditioning power and window of a vehicle (bus depot interface): the
// depot charging plan reserves the power while the vehicle preconditions.

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Label } from '@/components/ui/label';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { formatNumberUpTo } from '@/lib/formatting';

/** The two preconditioning inputs as typed, '' when empty. */
export interface VehiclePreconditioning {
  preconditioningPowerKw: string;
  preconditioningMinutes: string;
}

export const PRECONDITIONING_POWER_RANGE = { min: 0.5, max: 500 } as const;
export const PRECONDITIONING_MINUTES_RANGE = { min: 5, max: 240, default: 30 } as const;

/** The form values of a stored vehicle (the API sends a number or null, and a window length). */
export function preconditioningInputValues(vehicle?: {
  preconditioningPowerKw?: number | string | null;
  preconditioningMinutes?: number | null;
}): VehiclePreconditioning {
  return {
    preconditioningPowerKw:
      vehicle?.preconditioningPowerKw == null ? '' : String(Number(vehicle.preconditioningPowerKw)),
    preconditioningMinutes: String(
      vehicle?.preconditioningMinutes ?? PRECONDITIONING_MINUTES_RANGE.default,
    ),
  };
}

/** The power to send: null when empty (null clears it). */
export function preconditioningPowerBody(value: VehiclePreconditioning): number | null {
  const trimmed = value.preconditioningPowerKw.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The window length to send: the default when empty. */
export function preconditioningMinutesBody(value: VehiclePreconditioning): number {
  const trimmed = value.preconditioningMinutes.trim();
  return trimmed === '' ? PRECONDITIONING_MINUTES_RANGE.default : Number(trimmed);
}

/** A stored preconditioning power in the UI language, null when not set. */
export function formatPreconditioningPower(
  value: number | string | null | undefined,
): string | null {
  if (value == null) return null;
  return `${formatNumberUpTo(Number(value), 2)} kW`;
}

/** The range errors of the two fields, keyed by field. */
export function vehiclePreconditioningErrors(
  value: VehiclePreconditioning,
  t: TFunction,
): Partial<Record<keyof VehiclePreconditioning, string>> {
  const errors: Partial<Record<keyof VehiclePreconditioning, string>> = {};
  const power = preconditioningPowerBody(value);
  if (
    power != null &&
    (!Number.isFinite(power) ||
      power < PRECONDITIONING_POWER_RANGE.min ||
      power > PRECONDITIONING_POWER_RANGE.max)
  ) {
    errors.preconditioningPowerKw = t('vehicles.preconditioningPowerRange');
  }
  const minutes = preconditioningMinutesBody(value);
  if (
    !Number.isInteger(minutes) ||
    minutes < PRECONDITIONING_MINUTES_RANGE.min ||
    minutes > PRECONDITIONING_MINUTES_RANGE.max
  ) {
    errors.preconditioningMinutes = t('vehicles.preconditioningMinutesRange');
  }
  return errors;
}

/** The preconditioning power and window inputs of the vehicle create and edit forms. */
export function VehiclePreconditioningFields({
  idPrefix,
  value,
  onChange,
  errors,
}: {
  idPrefix: string;
  value: VehiclePreconditioning;
  onChange: (next: VehiclePreconditioning) => void;
  errors?: Partial<Record<keyof VehiclePreconditioning, string>> | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-preconditioning-power`} className="leading-6">
          {t('vehicles.preconditioningPowerKw')}
        </Label>
        <DecimalInput
          id={`${idPrefix}-preconditioning-power`}
          value={value.preconditioningPowerKw}
          decimalScale={2}
          onChange={(v) => {
            onChange({ ...value, preconditioningPowerKw: v });
          }}
          className={errors?.preconditioningPowerKw != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('vehicles.preconditioningPowerHelp')}</p>
        {errors?.preconditioningPowerKw != null && (
          <p className="text-sm text-destructive">{errors.preconditioningPowerKw}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-preconditioning-minutes`} className="leading-6">
          {t('vehicles.preconditioningMinutes')}
        </Label>
        <Input
          id={`${idPrefix}-preconditioning-minutes`}
          type="number"
          inputMode="numeric"
          min={PRECONDITIONING_MINUTES_RANGE.min}
          max={PRECONDITIONING_MINUTES_RANGE.max}
          step={1}
          value={value.preconditioningMinutes}
          onChange={(e) => {
            onChange({ ...value, preconditioningMinutes: e.target.value });
          }}
          className={errors?.preconditioningMinutes != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('vehicles.preconditioningMinutesHelp')}</p>
        {errors?.preconditioningMinutes != null && (
          <p className="text-sm text-destructive">{errors.preconditioningMinutes}</p>
        )}
      </div>
    </>
  );
}
