// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { DISTANCE_UNITS, isDistanceUnit, type DistanceUnit } from '@evtivity/lib/driver-defaults';
import { Select } from '@/components/ui/select';

const LABEL_KEYS = {
  miles: 'drivers.distanceUnitMiles',
  km: 'drivers.distanceUnitKm',
} as const satisfies Record<DistanceUnit, string>;

/** The translated name of a distance unit, or the value itself when it is unknown. */
export function useDistanceUnitLabel(): (unit: string) => string {
  const { t } = useTranslation();
  return (unit) => (isDistanceUnit(unit) ? t(LABEL_KEYS[unit]) : unit);
}

interface DistanceUnitSelectProps {
  id?: string | undefined;
  value: string;
  onChange: (value: DistanceUnit) => void;
  disabled?: boolean | undefined;
}

/** Miles or kilometers, the distance unit of a driver. */
export function DistanceUnitSelect({
  id,
  value,
  onChange,
  disabled,
}: DistanceUnitSelectProps): React.JSX.Element {
  const label = useDistanceUnitLabel();
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (isDistanceUnit(e.target.value)) onChange(e.target.value);
      }}
    >
      {DISTANCE_UNITS.map((unit) => (
        <option key={unit} value={unit}>
          {label(unit)}
        </option>
      ))}
    </Select>
  );
}
