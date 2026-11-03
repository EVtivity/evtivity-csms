// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CCS2: the Type 2 top with two DC pins below.
// The Stations list connector icon, in amber by default (the list only;
// the 2D site layout card uses the face pictograms).

import { SVG_COLORS } from '@/lib/chart-theme';
import { ConnectorSvg, type ConnectorIconProps } from './connector-svg';

export function Ccs2ListIcon({
  color = SVG_COLORS.connectorAmber,
  ...props
}: ConnectorIconProps): React.JSX.Element {
  return (
    <ConnectorSvg {...props} kind="ccs2" width={16} height={20} viewBox="0 0 16 20">
      <rect
        x="1.5"
        y="1"
        width="13"
        height="10"
        rx="4.5"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <circle cx="5.5" cy="4.5" r="0.8" fill={color} />
      <circle cx="10.5" cy="4.5" r="0.8" fill={color} />
      <circle cx="8" cy="4" r="0.8" fill={color} />
      <circle cx="5.5" cy="7.5" r="0.8" fill={color} />
      <circle cx="10.5" cy="7.5" r="0.8" fill={color} />
      <rect
        x="3"
        y="13"
        width="10"
        height="5"
        rx="2.5"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <circle cx="6" cy="15.5" r="1" fill={color} />
      <circle cx="10" cy="15.5" r="1" fill={color} />
    </ConnectorSvg>
  );
}
