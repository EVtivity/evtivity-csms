// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../config.js', () => ({ db: {}, client: vi.fn() }));

import { chargingSessions, chargingStations } from '../schema/index.js';
import {
  CONFORMANCE_CS_STATION_ID_PREFIX,
  CONFORMANCE_STATION_ID_PREFIX,
  inOperatorStation,
  isOperatorStation,
  operatorStationIdSql,
  operatorStationSql,
} from '../lib/conformance-stations.js';

const dialect = new PgDialect();

describe('conformance station predicates', () => {
  it('keeps operator stations of a station alias', () => {
    expect(operatorStationSql('cs')).toBe('cs.is_conformance = false');
  });

  it('leaves out rows of conformance stations by station id, null-safe', () => {
    const text = operatorStationIdSql('s.station_id');
    expect(text).toBe(
      'NOT EXISTS (SELECT 1 FROM charging_stations conf_st WHERE conf_st.id = s.station_id AND conf_st.is_conformance)',
    );
  });

  it('builds the Drizzle condition on the station table', () => {
    const query = dialect.sqlToQuery(isOperatorStation());
    expect(query.sql).toBe('"charging_stations"."is_conformance" = $1');
    expect(query.params).toEqual([false]);
  });

  it('builds the Drizzle condition on a column holding a station id', () => {
    const query = dialect.sqlToQuery(inOperatorStation(chargingSessions.stationId));
    expect(query.sql).toBe(
      'NOT EXISTS (SELECT 1 FROM charging_stations conf_st WHERE conf_st.id = "charging_sessions"."station_id" AND conf_st.is_conformance)',
    );
  });

  it('accepts another station table reference', () => {
    const query = dialect.sqlToQuery(isOperatorStation(chargingStations));
    expect(query.sql).toContain('is_conformance');
  });

  it('names the runner id prefixes, CS inside the conformance prefix', () => {
    expect(CONFORMANCE_CS_STATION_ID_PREFIX.startsWith(CONFORMANCE_STATION_ID_PREFIX)).toBe(true);
  });
});
