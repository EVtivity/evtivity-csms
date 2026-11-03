// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Type 2 (IEC 62196-2, Mennekes): seven pins in a rounded housing (AC).
// The Stations list connector icon, in the text color by default (the list only;
// the 2D site layout card uses the face pictograms).

import { ConnectorSvg, type ConnectorIconProps } from './connector-svg';

export function Type2ListIcon({
  color = 'currentColor',
  ...props
}: ConnectorIconProps): React.JSX.Element {
  return (
    <ConnectorSvg {...props} kind="type2" width={16} height={16} viewBox="0 0 16 16">
      <rect
        x="1"
        y="2"
        width="14"
        height="12"
        rx="5"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
      />
      <circle cx="5" cy="6" r="0.9" fill={color} />
      <circle cx="8" cy="5.5" r="0.9" fill={color} />
      <circle cx="11" cy="6" r="0.9" fill={color} />
      <circle cx="5" cy="9.5" r="0.9" fill={color} />
      <circle cx="8" cy="10" r="0.9" fill={color} />
      <circle cx="11" cy="9.5" r="0.9" fill={color} />
      <circle cx="8" cy="7.8" r="0.9" fill={color} />
    </ConnectorSvg>
  );
}
