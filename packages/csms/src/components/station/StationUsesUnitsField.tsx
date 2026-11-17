// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';

/**
 * The Uses Station Units switch of the New Station page and the station edit
 * form. Off: the station has no units and the EVSE & Connectors tab shows no
 * unit controls.
 */
export function StationUsesUnitsField({
  id,
  checked,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3">
      <Toggle
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
      />
      <div className="space-y-1">
        <Label id={`${id}-label`} htmlFor={id}>
          {t('stations.usesUnits')}
        </Label>
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {t('stations.usesUnitsHelp')}
        </p>
      </div>
    </div>
  );
}
