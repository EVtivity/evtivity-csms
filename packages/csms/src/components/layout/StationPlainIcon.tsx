// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The plain charger drawing of the 2D card (a DC dispenser or an AC
// pedestal), shown while the 3D picture renders and when the browser has no
// WebGL. No state color: the card's badges carry the state.

import { SVG_COLORS } from '@/lib/chart-theme';

export function StationPlainIcon({
  dc,
  width,
  height,
}: {
  dc: boolean;
  width: number;
  height: number;
}): React.JSX.Element {
  if (dc) {
    return (
      <svg width={width} height={height} viewBox="0 0 52 62" aria-hidden="true">
        <rect
          x="4"
          y="2"
          width="44"
          height="52"
          rx="5"
          fill={SVG_COLORS.stationBody}
          stroke={SVG_COLORS.stationStroke}
          strokeWidth="1.5"
        />
        <rect
          x="9"
          y="6"
          width="34"
          height="20"
          rx="2"
          fill={SVG_COLORS.stationPort}
          opacity="0.35"
        />
        <rect x="10" y="32" width="12" height="7" rx="2" fill={SVG_COLORS.stationPort} />
        <rect x="30" y="32" width="12" height="7" rx="2" fill={SVG_COLORS.stationPort} />
        <path
          d="M16 39 Q16 46 13 50"
          fill="none"
          stroke={SVG_COLORS.stationPort}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M36 39 Q36 46 39 50"
          fill="none"
          stroke={SVG_COLORS.stationPort}
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width={width} height={height} viewBox="0 0 48 56" aria-hidden="true">
      <rect
        x="8"
        y="4"
        width="32"
        height="44"
        rx="4"
        fill={SVG_COLORS.stationBody}
        stroke={SVG_COLORS.stationStroke}
        strokeWidth="1.5"
      />
      <rect
        x="12"
        y="8"
        width="24"
        height="16"
        rx="2"
        fill={SVG_COLORS.stationPort}
        opacity="0.35"
      />
      <rect x="14" y="30" width="8" height="5" rx="1" fill={SVG_COLORS.stationPort} />
      <rect x="26" y="30" width="8" height="5" rx="1" fill={SVG_COLORS.stationPort} />
    </svg>
  );
}
