// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';

/**
 * Stand-ins for the conformance station predicates of `@evtivity/database`
 * (`lib/conformance-stations.ts`) in a mocked database module. Spread them
 * into the `vi.mock('@evtivity/database', async () => ({ ... }))` factory:
 *
 *   ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
 *
 * The Drizzle predicates return marker objects and the SQL text helpers
 * return marker text, so a test asserts the predicate reached the query
 * (`vi.mocked(isOperatorStation)` was called, or the SQL text names
 * `OPERATOR_STATION(<alias>)` / `OPERATOR_STATION_ID(<column>)`).
 */
export function conformanceStationMocks() {
  return {
    CONFORMANCE_STATION_ID_PREFIX: 'OCTT-',
    CONFORMANCE_CS_STATION_ID_PREFIX: 'OCTT-CS-',
    isOperatorStation: vi.fn(() => ({ conformancePredicate: 'isOperatorStation' })),
    inOperatorStation: vi.fn((column: unknown) => ({
      conformancePredicate: 'inOperatorStation',
      column,
    })),
    operatorStationSql: vi.fn((alias: string) => `OPERATOR_STATION(${alias})`),
    operatorStationIdSql: vi.fn((column: string) => `OPERATOR_STATION_ID(${column})`),
  };
}
