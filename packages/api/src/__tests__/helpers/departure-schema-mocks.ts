// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The departure enum lists route schemas read at load time, for tests that
// replace @evtivity/database with a factory.

import {
  DEPARTURE_OUTCOMES,
  DEPARTURE_READINESS_REASONS,
  DEPARTURE_READINESS_STATES,
  DEPARTURE_SOURCES,
  DEPARTURE_STATUSES,
  DEPARTURE_TARGET_KINDS,
} from '@evtivity/database/src/schema/departures.js';

export function departureSchemaMocks(): Record<string, unknown> {
  return {
    DEPARTURE_OUTCOMES,
    DEPARTURE_READINESS_REASONS,
    DEPARTURE_READINESS_STATES,
    DEPARTURE_SOURCES,
    DEPARTURE_STATUSES,
    DEPARTURE_TARGET_KINDS,
  };
}
