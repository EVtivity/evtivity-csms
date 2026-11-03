// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

/** Whether a station is connected: the Online or Offline badge of the Stations list. */
export function StationOnlineBadge({
  isOnline,
  size,
}: {
  isOnline: boolean;
  /** `sm` in a dense card (the 2D site layout charger card). */
  size?: 'default' | 'sm' | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Badge
      variant={isOnline ? 'success' : 'destructive'}
      size={size}
      data-testid="station-online-badge"
    >
      {isOnline ? t('status.online') : t('status.offline')}
    </Badge>
  );
}
