// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Site Type select of the site Details edit form and the New Site page,
// with the Charger Placement select a parking lot adds.

import { useTranslation } from 'react-i18next';
import {
  CHARGER_PLACEMENTS,
  SITE_TYPES,
  type ChargerPlacement,
  type SiteType,
} from '@evtivity/lib/site-layout';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CHARGER_PLACEMENT_LABEL, SITE_TYPE_LABEL } from './site-type';

interface SiteTypeFieldProps {
  id: string;
  value: SiteType;
  onChange: (value: SiteType) => void;
  /** The parking lot's charger placement (shown only for a parking lot). */
  placement: ChargerPlacement;
  onPlacementChange: (value: ChargerPlacement) => void;
}

export function SiteTypeField({
  id,
  value,
  onChange,
  placement,
  onPlacementChange,
}: SiteTypeFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={id} className="leading-6">
          {t('sites.layoutSettings.siteType')}
        </Label>
        <Select
          id={id}
          value={value}
          onChange={(e) => {
            onChange(e.target.value as SiteType);
          }}
        >
          {SITE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(SITE_TYPE_LABEL[type])}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t('sites.layoutSettings.siteTypeHint')}</p>
      </div>
      {value === 'parking_lot' && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-placement`} className="leading-6">
            {t('sites.layoutSettings.chargerPlacement')}
          </Label>
          <Select
            id={`${id}-placement`}
            value={placement}
            onChange={(e) => {
              onPlacementChange(e.target.value as ChargerPlacement);
            }}
          >
            {CHARGER_PLACEMENTS.map((p) => (
              <option key={p} value={p}>
                {t(CHARGER_PLACEMENT_LABEL[p])}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('sites.layoutSettings.chargerPlacementHint')}
          </p>
        </div>
      )}
    </>
  );
}
