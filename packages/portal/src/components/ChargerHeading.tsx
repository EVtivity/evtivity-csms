// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

interface ChargerHeadingProps {
  /** The charger name: the unit (box) name on a station with units, else the station id. */
  title: string;
  /** The station id under a unit name; null when the title already is the station. */
  stationId: string | null;
  siteName: string | null;
  /** Shown right of the title (the favorite star of the signed-in page). */
  adornment?: React.ReactNode;
  /** Centered on the guest landing cards, left on the signed-in page. */
  align?: 'start' | 'center';
}

/**
 * The heading of a charger page: the charger name, the station of a unit
 * charger, then the location. One component, so the signed-in and the guest
 * pages show a unit charger with the same lines and typography.
 */
export function ChargerHeading({
  title,
  stationId,
  siteName,
  adornment,
  align = 'start',
}: ChargerHeadingProps): React.JSX.Element {
  return (
    <div className={cn(align === 'center' && 'text-center')}>
      <div className={cn('flex items-center gap-1.5', align === 'center' && 'justify-center')}>
        <h1 className="text-xl font-bold" data-testid="charger-title">
          {title}
        </h1>
        {adornment}
      </div>
      {stationId != null && (
        <p className="text-xs text-muted-foreground" data-testid="charger-station-id">
          {stationId}
        </p>
      )}
      {siteName != null && <p className="text-xs text-muted-foreground">{siteName}</p>}
    </div>
  );
}
