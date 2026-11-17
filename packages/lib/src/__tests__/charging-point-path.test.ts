// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { chargingPointPath, chargingPointPathParts } from '../charging-point-path.js';

const labels = {
  evse: (id: number) => `EVSE ${String(id)}`,
  connector: (id: number) => `Connector ${String(id)}`,
  connectorType: (type: string) => (type === 'Type2' ? 'Type 2' : type),
};

describe('chargingPointPath', () => {
  it('joins site, station, unit, EVSE and connector type on one line', () => {
    expect(
      chargingPointPath(
        {
          siteName: 'Parkhaus Lindenhof',
          stationName: 'EM4-MASTER-01',
          unitName: 'Box 3',
          evseId: 5,
          connectorId: 1,
          connectorType: 'CCS2',
        },
        labels,
      ),
    ).toBe('Parkhaus Lindenhof / EM4-MASTER-01 / Box 3 / EVSE 5 / CCS2');
  });

  it('leaves out the parts the session does not have', () => {
    expect(
      chargingPointPath(
        {
          siteName: 'Main',
          stationName: 'CS-1',
          evseId: 2,
          connectorId: 1,
          connectorType: 'Type2',
        },
        labels,
      ),
    ).toBe('Main / CS-1 / EVSE 2 / Type 2');
    expect(chargingPointPath({ siteName: null, stationName: 'CS-1', evseId: 1 }, labels)).toBe(
      'CS-1 / EVSE 1',
    );
    expect(chargingPointPath({ siteName: 'Main', stationName: 'CS-1' }, labels)).toBe(
      'Main / CS-1',
    );
  });

  it('names the connector by its number when its type is unknown', () => {
    expect(
      chargingPointPathParts(
        { stationName: 'CS-1', evseId: 1, connectorId: 2, connectorType: ' ' },
        labels,
      ),
    ).toEqual(['CS-1', 'EVSE 1', 'Connector 2']);
  });

  it('starts at the station or the unit when the list already names them', () => {
    const input = { siteName: 'Main', stationName: 'CS-1', unitName: 'Box 1', evseId: 1 };
    expect(chargingPointPath(input, labels, { hideSite: true })).toBe('CS-1 / Box 1 / EVSE 1');
    expect(chargingPointPath(input, labels, { hideStation: true })).toBe('Box 1 / EVSE 1');
  });
});
