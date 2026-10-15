// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A stored decimal-degree coordinate as an OCPI GeoLocation value (8.4.16:
 * latitude `-?[0-9]{1,2}\.[0-9]{5,7}`, longitude `-?[0-9]{1,3}\.[0-9]{5,7}`):
 * six decimals, about 0.1 m. Sites store what the operator typed ("40",
 * "52.52"), which partners that validate the pattern refuse. A value that is
 * not a number is sent as 0.
 */
export function ocpiCoordinate(value: string): string {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(6);
}
