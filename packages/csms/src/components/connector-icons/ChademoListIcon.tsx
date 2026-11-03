// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CHAdeMO: a large round connector with its pins.
// The Stations list connector icon, in amber by default (the list only;
// the 2D site layout card uses the face pictograms).

import { SVG_COLORS } from '@/lib/chart-theme';
import { ConnectorSvg, type ConnectorIconProps } from './connector-svg';

export function ChademoListIcon({
  color = SVG_COLORS.connectorAmber,
  ...props
}: ConnectorIconProps): React.JSX.Element {
  return (
    <ConnectorSvg {...props} kind="chademo" width={16} height={16} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="7" fill="none" stroke={color} strokeWidth="1.2" />
      <circle cx="5" cy="5.5" r="1" fill={color} />
      <circle cx="11" cy="5.5" r="1" fill={color} />
      <circle cx="5" cy="10.5" r="1" fill={color} />
      <circle cx="11" cy="10.5" r="1" fill={color} />
      <circle cx="8" cy="8" r="1.2" fill={color} />
    </ConnectorSvg>
  );
}
