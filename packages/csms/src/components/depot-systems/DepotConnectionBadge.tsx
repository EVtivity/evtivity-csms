// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { isConnectedNow, type DepotSystem } from './depot-system-types';

/** Off, Sign-Ins Locked, Connected or Not Connected, for a bus depot system. */
export function DepotConnectionBadge({ system }: { system: DepotSystem }): React.JSX.Element {
  const { t } = useTranslation();
  if (!system.isEnabled) return <Badge variant="outline">{t('depotSystems.state.off')}</Badge>;
  if (system.locked) {
    return <Badge variant="destructive">{t('depotSystems.state.locked')}</Badge>;
  }
  return isConnectedNow(system) ? (
    <Badge variant="success">{t('depotSystems.state.connected')}</Badge>
  ) : (
    <Badge variant="secondary">{t('depotSystems.state.notConnected')}</Badge>
  );
}
