// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Type 1 (SAE J1772): five pins in a round housing (AC).
// The Stations list connector icon, in the text color by default (the list only;
// the 2D site layout card uses the face pictograms).

import { ConnectorSvg, type ConnectorIconProps } from './connector-svg';

export function Type1ListIcon({
  color = 'currentColor',
  ...props
}: ConnectorIconProps): React.JSX.Element {
  return (
    <ConnectorSvg {...props} kind="type1" width={16} height={16} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="7" fill="none" stroke={color} strokeWidth="1.2" />
      <circle cx="5.5" cy="6" r="1" fill={color} />
      <circle cx="10.5" cy="6" r="1" fill={color} />
      <circle cx="4.5" cy="9.5" r="1" fill={color} />
      <circle cx="11.5" cy="9.5" r="1" fill={color} />
      <circle cx="8" cy="11" r="1" fill={color} />
    </ConnectorSvg>
  );
}
