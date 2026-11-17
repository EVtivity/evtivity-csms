// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { FleetCombobox, type FleetSelection } from '@/components/fleet-combobox';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';

interface TokenFleetSelectProps {
  id: string;
  /** The fleet id, '' for no fleet. */
  value: string;
  onChange: (value: string) => void;
  /** The card's fleet now, shown as the pick until another fleet is picked. */
  current?: { id: string; name: string | null } | null;
}

/**
 * The fleet that owns an RFID card, for operators: shown while the Fleets
 * feature is on and the user may read fleets, write fleet cards and reach every site. Fleets are searched by name,
 * so every fleet can be picked, not only a first page.
 */
export function TokenFleetSelect({
  id,
  value,
  onChange,
  current,
}: TokenFleetSelectProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const { fleetEnabled } = useFeatureFlags().flags;
  const canReadFleets = useHasPermission('fleets:read');
  // The API refuses a card's fleet without fleetCards:write.
  const canWriteFleetCards = useHasPermission('fleetCards:write');
  // The API refuses a fleet from a site-restricted operator: fleet cards span every site.
  const allSites = useHasAllSiteAccess();
  const [picked, setPicked] = useState<FleetSelection | null>(null);

  if (!(fleetEnabled && canReadFleets && canWriteFleetCards && allSites)) return null;
  const selection: FleetSelection | null =
    value === ''
      ? null
      : picked?.id === value
        ? picked
        : current?.id === value
          ? { id: current.id, name: current.name ?? t('tokens.fleet') }
          : { id: value, name: t('tokens.fleet') };

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="leading-6">
        {t('tokens.fleet')}
      </Label>
      <FleetCombobox
        id={id}
        value={selection}
        onSelect={(fleet) => {
          setPicked(fleet);
          onChange(fleet?.id ?? '');
        }}
      />
      <p className="text-sm text-muted-foreground">{t('tokens.fleetHint')}</p>
    </div>
  );
}
