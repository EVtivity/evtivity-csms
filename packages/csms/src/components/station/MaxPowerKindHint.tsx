// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { connectorNeedsMaxPower } from '@evtivity/lib/connector-power';

/**
 * Under Max Power of a NACS, GB/T or Tesla connector: its power decides AC or
 * DC, and so which tariffs price it (owner decision 2026-11-13).
 */
export function MaxPowerKindHint({
  connectorType,
}: {
  connectorType: string | null | undefined;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!connectorNeedsMaxPower(connectorType)) return null;
  return <p className="text-xs text-muted-foreground">{t('stations.maxPowerKindHint')}</p>;
}
