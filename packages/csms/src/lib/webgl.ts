// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Whether this browser can render WebGL (the 3D site layout needs it). */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') != null || canvas.getContext('webgl') != null;
  } catch {
    // fail-open: a browser that throws on getContext has no WebGL, so the 2D view shows
    return false;
  }
}
