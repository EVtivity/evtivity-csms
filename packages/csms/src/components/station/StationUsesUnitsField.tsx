// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/**
 * The Uses Station Units checkbox of the New Station page and the station edit
 * form, laid out like the Simulator station checkbox. Unchecked: the station
 * has no units and the EVSE & Connectors tab shows no unit controls.
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
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onChange={(e) => {
            onCheckedChange(e.target.checked);
          }}
          aria-describedby={`${id}-help`}
        />
        <Label htmlFor={id}>{t('stations.usesUnits')}</Label>
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t('stations.usesUnitsHelp')}
      </p>
    </div>
  );
}
