// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// NACS (SAE J3400): an oval connector.
// The Stations list connector icon, in amber by default (the list only;
// the 2D site layout card uses the face pictograms).

import { SVG_COLORS } from '@/lib/chart-theme';
import { ConnectorSvg, type ConnectorIconProps } from './connector-svg';

export function NacsListIcon({
  color = SVG_COLORS.connectorAmber,
  ...props
}: ConnectorIconProps): React.JSX.Element {
  return (
    <ConnectorSvg {...props} kind="nacs" width={12} height={16} viewBox="0 0 12 16">
      <rect
        x="1"
        y="1"
        width="10"
        height="14"
        rx="5"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <circle cx="6" cy="5.5" r="1" fill={color} />
      <circle cx="6" cy="10.5" r="1" fill={color} />
    </ConnectorSvg>
  );
}
