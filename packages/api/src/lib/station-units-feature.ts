// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AppError } from '@evtivity/lib';

/** The refusal of a unit write while the Enable Station Units setting is off. */
export function stationUnitsFeatureOffError(): AppError {
  return new AppError(
    'Station units are turned off: turn on Enable Station Units in Settings > Integrations & Features first',
    409,
    'STATION_UNITS_FEATURE_OFF',
  );
}
