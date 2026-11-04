// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Label } from '@/components/ui/label';
import { DecimalInput } from '@/components/ui/decimal-input';
import { formatNumberUpTo } from '@/lib/formatting';

/** The two battery inputs as typed: a canonical decimal string, '' when empty. */
export interface VehicleBattery {
  batteryCapacityKwh: string;
  maxChargePowerKw: string;
}

export const BATTERY_CAPACITY_RANGE = { min: 1, max: 2000 } as const;
export const MAX_CHARGE_POWER_RANGE = { min: 1, max: 3750 } as const;

/** The form value of a stored battery field (the API sends a number or null). */
export function batteryInputValue(value: number | string | null | undefined): string {
  if (value == null) return '';
  return String(Number(value));
}

/** A stored battery value with its unit in the UI language, null when not set. */
export function formatBatteryValue(
  value: number | string | null | undefined,
  unit: 'kWh' | 'kW',
): string | null {
  if (value == null) return null;
  return `${formatNumberUpTo(Number(value), 2)} ${unit}`;
}

/** The number to send for a typed battery field: null when empty. */
export function batteryBodyValue(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The range errors of the two battery fields, keyed by field. */
export function vehicleBatteryErrors(
  value: VehicleBattery,
  t: TFunction,
): Partial<Record<keyof VehicleBattery, string>> {
  const errors: Partial<Record<keyof VehicleBattery, string>> = {};
  const capacity = batteryBodyValue(value.batteryCapacityKwh);
  if (
    capacity != null &&
    (capacity < BATTERY_CAPACITY_RANGE.min || capacity > BATTERY_CAPACITY_RANGE.max)
  ) {
    errors.batteryCapacityKwh = t('vehicles.batteryCapacityRange');
  }
  const power = batteryBodyValue(value.maxChargePowerKw);
  if (power != null && (power < MAX_CHARGE_POWER_RANGE.min || power > MAX_CHARGE_POWER_RANGE.max)) {
    errors.maxChargePowerKw = t('vehicles.maxChargePowerRange');
  }
  return errors;
}

/** The battery capacity and max charge power inputs of the vehicle create and edit forms. */
export function VehicleBatteryFields({
  idPrefix,
  value,
  onChange,
  errors,
}: {
  idPrefix: string;
  value: VehicleBattery;
  onChange: (next: VehicleBattery) => void;
  errors?: Partial<Record<keyof VehicleBattery, string>> | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-battery-capacity`} className="leading-6">
          {t('vehicles.batteryCapacityKwh')}
        </Label>
        <DecimalInput
          id={`${idPrefix}-battery-capacity`}
          value={value.batteryCapacityKwh}
          decimalScale={2}
          onChange={(v) => {
            onChange({ ...value, batteryCapacityKwh: v });
          }}
          className={errors?.batteryCapacityKwh != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('vehicles.batteryCapacityHelp')}</p>
        {errors?.batteryCapacityKwh != null && (
          <p className="text-sm text-destructive">{errors.batteryCapacityKwh}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-max-charge-power`} className="leading-6">
          {t('vehicles.maxChargePowerKw')}
        </Label>
        <DecimalInput
          id={`${idPrefix}-max-charge-power`}
          value={value.maxChargePowerKw}
          decimalScale={2}
          onChange={(v) => {
            onChange({ ...value, maxChargePowerKw: v });
          }}
          className={errors?.maxChargePowerKw != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('vehicles.maxChargePowerHelp')}</p>
        {errors?.maxChargePowerKw != null && (
          <p className="text-sm text-destructive">{errors.maxChargePowerKw}</p>
        )}
      </div>
    </>
  );
}
