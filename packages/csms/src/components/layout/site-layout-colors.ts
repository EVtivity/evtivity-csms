// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Model paint of the 3D site layout (the lot and the charger bodies, not
// status colors). The legend reads the AC and DC accents without loading three.js.
export const SCENE_COLORS = {
  light: { asphalt: '#4a515c', concrete: '#b9bec6', paint: '#f4f4f2', shell: '#e8ebef' },
  dark: { asphalt: '#2b313b', concrete: '#6f7783', paint: '#d9dbd8', shell: '#c9ced6' },
  ac: '#2563eb',
  dc: '#ea7a1a',
  bollard: '#d4a017',
  dark1: '#20252d',
  rubber: '#15181d',
  glass: '#0b1220',
  screenGlow: '#1d3a6e',
} as const;
