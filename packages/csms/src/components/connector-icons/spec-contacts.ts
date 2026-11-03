// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The face pictograms read their contact centers from CONNECTOR_SPECS, the
// one geometry source of the connectors, which the 3D handles use too.

import type { ConnectorContact } from '../layout/site-layout-connectors';

/** Contact `index` of a spec in pictogram millimeters: x as is, y pointing down. */
export function specContactMm(
  contacts: readonly ConnectorContact[],
  index: number,
): { x: number; y: number } {
  const c = contacts[index];
  if (c == null) throw new Error(`No contact ${String(index)} in the connector spec`);
  // Round to 0.01 mm so the numbers read as the cited ones.
  return { x: Math.round(c.x * 100000) / 100, y: Math.round(-c.y * 100000) / 100 };
}
