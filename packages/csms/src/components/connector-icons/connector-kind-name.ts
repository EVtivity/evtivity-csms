// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The standard name of each connector kind, the same in every language
// (the names of the standards: SAE J1772 Type 1, IEC 62196 Type 2, the
// combined CCS1 and CCS2, CHAdeMO, SAE J3400 NACS, MCS).

import type { ConnectorKind } from '../layout/site-layout-connectors';

export const CONNECTOR_KIND_NAMES: Record<ConnectorKind, string> = {
  type1: 'Type 1',
  type2: 'Type 2',
  ccs1: 'CCS1',
  ccs2: 'CCS2',
  chademo: 'CHAdeMO',
  nacs: 'NACS',
  mcs: 'MCS',
};
