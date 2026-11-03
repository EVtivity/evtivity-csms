// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { stationStatusVariant, stationStatusClassName } from '@/lib/status-variants';

interface StationStatusBadgeProps {
  status: string;
  // Why the station is not available (from the API `statusReason`), null when it is.
  statusReason?: string | null | undefined;
  /** `sm` in a dense card (the 2D site layout charger card). */
  size?: 'default' | 'sm' | undefined;
}

// The station status every surface shows. When the station is unavailable or
// faulted, a tooltip says why (disabled by an operator or a security event,
// firmware, the station itself, or a faulted connector).
export function StationStatusBadge({
  status,
  statusReason,
  size,
}: StationStatusBadgeProps): React.JSX.Element {
  const { t } = useTranslation();
  const badge = (
    <Badge
      variant={stationStatusVariant(status)}
      size={size}
      className={stationStatusClassName(status)}
    >
      {t(`status.${status}`, { defaultValue: status })}
    </Badge>
  );
  if (statusReason == null || (status !== 'unavailable' && status !== 'faulted')) {
    return badge;
  }
  return (
    <Tooltip content={t(`stations.statusReason.${statusReason}`, statusReason)}>{badge}</Tooltip>
  );
}
