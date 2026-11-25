// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export type VehicleAcPhases = 1 | 3;

/** The stored AC phases of a vehicle (the API sends 1, 3 or null). */
export function acPhasesOf(value: unknown): VehicleAcPhases | null {
  return value === 1 || value === 3 ? value : null;
}

/** The label of a stored AC phases value, `n/a` when not known. */
export function vehicleAcPhasesLabel(value: unknown, t: TFunction): string {
  const phases = acPhasesOf(value);
  if (phases == null) return 'n/a';
  return phases === 1 ? t('vehicles.acPhasesSingle') : t('vehicles.acPhasesThree');
}

/** The AC phases select of the vehicle create and edit forms (empty is Not Known). */
export function VehicleAcPhasesField({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: VehicleAcPhases | null;
  onChange: (next: VehicleAcPhases | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-ac-phases`} className="leading-6">
        {t('vehicles.acPhases')}
      </Label>
      <Select
        id={`${idPrefix}-ac-phases`}
        value={value == null ? '' : String(value)}
        onChange={(e) => {
          onChange(acPhasesOf(Number(e.target.value)));
        }}
      >
        <option value="">{t('vehicles.acPhasesUnknown')}</option>
        <option value="1">{t('vehicles.acPhasesSingle')}</option>
        <option value="3">{t('vehicles.acPhasesThree')}</option>
      </Select>
      <p className="text-xs text-muted-foreground">{t('vehicles.acPhasesHelp')}</p>
    </div>
  );
}
