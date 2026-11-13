// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A connector's face pictogram (`components/connector-icons/`, one file per
// type, drawn from the measured faces of the standards) with an accessible
// name, in its status icon color (`statusIconColor`, at least 3:1 on the card
// in each theme; owner rule 2026-11-02: each port on the 2D charger card
// shows only its icon, in the connector status color), else the text color.
// The Stations list keeps its own icons (`*ListIcon`).

import { statusIconColor } from '@/lib/chart-theme';
import { useDarkTheme } from '@/hooks/use-dark-theme';
import { CONNECTOR_ICONS } from './connector-icons/connector-icon-of';
import type { ConnectorIconSize } from '@evtivity/lib/connector-faces';
import { connectorKindOf } from './layout/site-layout-connectors';

export function ConnectorTypeIcon({
  type,
  status,
  dc,
  label,
  size = 20,
  className,
}: {
  /** The connector type as the station reports it (OCPP or CSMS spelling). */
  type: string | null;
  /** The connector status (CSMS form, lowercase): the icon's color; absent uses the text color. */
  status?: string | undefined;
  /** The station charges DC (the default plug when the type is unknown). */
  dc: boolean;
  /** The accessible name and title (for example "EVSE 1, CCS1, Charging"). */
  label: string;
  /** The rendered size in px; the detail and line width are tuned per size. */
  size?: ConnectorIconSize;
  className?: string;
}): React.JSX.Element {
  const kind = connectorKindOf(type, dc);
  const Icon = CONNECTOR_ICONS[kind];
  const dark = useDarkTheme();
  const color = status != null ? statusIconColor(status, dark) : 'currentColor';
  return (
    <span className="inline-flex shrink-0" data-status={status}>
      <Icon label={label} color={color} size={size} className={className} />
    </span>
  );
}
