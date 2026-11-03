// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { normalizeChargerPlateColor, resolveBrandColor } from '@evtivity/lib/charger-plate-colors';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Label } from '@/components/ui/label';

export interface ChargerPlateColors {
  chargerColorAc: string;
  chargerColorDc: string;
}

/** The plate color fields that are neither empty nor a #rrggbb color. */
export function chargerPlateColorErrors(
  values: ChargerPlateColors,
): Partial<Record<keyof ChargerPlateColors, true>> {
  const errors: Partial<Record<keyof ChargerPlateColors, true>> = {};
  if (normalizeChargerPlateColor(values.chargerColorAc) == null) errors.chargerColorAc = true;
  if (normalizeChargerPlateColor(values.chargerColorDc) == null) errors.chargerColorDc = true;
  return errors;
}

interface ChargerPlateColorFieldsProps extends ChargerPlateColors {
  /** company.themeColor as the form holds it: what an empty field paints. */
  themeColor: string;
  showErrors: boolean;
  onChange: (key: keyof ChargerPlateColors, value: string) => void;
}

const FIELDS = [
  { key: 'chargerColorAc', id: 'company-charger-color-ac', i18n: 'chargerColorAc' },
  { key: 'chargerColorDc', id: 'company-charger-color-dc', i18n: 'chargerColorDc' },
] as const;

export function ChargerPlateColorFields({
  chargerColorAc,
  chargerColorDc,
  themeColor,
  showErrors,
  onChange,
}: ChargerPlateColorFieldsProps): React.JSX.Element {
  const { t } = useTranslation();
  const values: ChargerPlateColors = { chargerColorAc, chargerColorDc };
  const errors = chargerPlateColorErrors(values);
  const brandColor = resolveBrandColor(themeColor);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {FIELDS.map(({ key, id, i18n }) => {
        const value = values[key];
        const invalid = showErrors && errors[key] === true;
        const stored = normalizeChargerPlateColor(value);
        const pickerValue = stored != null && stored !== '' ? stored : brandColor;
        return (
          <div key={key} className="space-y-2">
            <Label htmlFor={id} className="leading-6">
              {t(`settings.${i18n}`)}
            </Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                aria-label={t(`settings.${i18n}Picker`)}
                value={pickerValue}
                onChange={(e) => {
                  onChange(key, e.target.value);
                }}
                className="h-9 w-9 shrink-0 cursor-pointer rounded-md border p-0.5"
              />
              <ClearableInput
                id={id}
                value={value}
                onChange={(next) => {
                  onChange(key, next);
                }}
                invalid={invalid}
                clearLabel={t('settings.chargerColorClear')}
                placeholder={brandColor}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${id}-error ${id}-hint` : `${id}-hint`}
                className="w-36"
              />
            </div>
            {invalid && (
              <p id={`${id}-error`} className="text-sm text-destructive">
                {t('validation.hexColor')}
              </p>
            )}
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {t(`settings.${i18n}Description`)}
            </p>
          </div>
        );
      })}
    </div>
  );
}
