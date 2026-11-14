// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { evses, stationUnitBoardPositions, stationUnits } from '../schema/assets.js';
import { driverFavoriteStations, stationWatches } from '../schema/drivers.js';
import { stationAuditActionEnum } from '../schema/audit.js';

describe('station units schema', () => {
  it('declares station_units with its name, order and optional admin metadata columns', () => {
    const cfg = getTableConfig(stationUnits);
    expect(cfg.name).toBe('station_units');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        'created_at',
        'id',
        'ip_address',
        'name',
        'name_updated_at',
        'serial_number',
        'sort_order',
        'station_id',
        'updated_at',
      ].sort(),
    );
    for (const name of ['serial_number', 'ip_address']) {
      expect(cfg.columns.find((c) => c.name === name)?.notNull).toBe(false);
    }
    // When the name, the one field partners see, last changed.
    expect(cfg.columns.find((c) => c.name === 'name_updated_at')?.notNull).toBe(true);
    expect(cfg.uniqueConstraints.map((u) => u.name)).toContain('uq_station_units_id_station');
  });

  it('gives evses a nullable unit_id kept on its own station', () => {
    const cfg = getTableConfig(evses);
    const unit = cfg.columns.find((c) => c.name === 'unit_id');
    expect(unit?.notNull).toBe(false);
    const fk = cfg.foreignKeys.find((f) => f.getName() === 'fk_evses_unit_same_station');
    expect(fk?.reference().columns.map((c) => c.name)).toEqual(['unit_id', 'station_id']);
  });

  it('adds a unit to favorites and watches, deleted with the unit', () => {
    for (const table of [driverFavoriteStations, stationWatches]) {
      const cfg = getTableConfig(table);
      expect(cfg.columns.find((c) => c.name === 'unit_id')?.notNull).toBe(false);
      const fk = cfg.foreignKeys.find((f) => f.getName().endsWith('_unit'));
      expect(fk?.onDelete).toBe('cascade');
    }
  });

  it('declares the unit board positions and the audit action', () => {
    expect(getTableConfig(stationUnitBoardPositions).name).toBe('station_unit_board_positions');
    expect(stationAuditActionEnum.enumValues).toContain('unit_changed');
  });
});
