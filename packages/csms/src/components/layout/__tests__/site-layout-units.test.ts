// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { effectiveLayoutSettings, bayToPosition, positionToBay } from '@evtivity/lib/site-layout';
import {
  chargerEvseNumber,
  expandUnitStations,
  layoutChargerName,
  layoutKindOfStation,
  layoutStationIdOf,
  stationPlacementOfUnit,
  unitChargerStatus,
  unitChargerViewId,
  unitPartnerCol,
  viewStationTerminals,
} from '../site-layout-units';
import { freeStationPlaces, layoutViewStations } from '../site-layout-free';
import { withUnitChargers, type LinkPanel } from '../site-layout-links';
import { replayFrame, type ReplayDay } from '../site-layout-replay';
import { stationThumbnailModel } from '../site-layout-station-thumbnail';
import { drawnEvseConnectors, stationPlugs } from '../site-layout-station-plugs';
import type { LayoutStation } from '../StationCard';
import type { LayoutTerminal } from '../layout-terminals';

const t = ((key: string, opts?: Record<string, string>) =>
  key === 'layout.units.chargerName' && opts != null
    ? `${opts['station'] ?? ''}, ${opts['unit'] ?? ''}`
    : key) as unknown as TFunction;

const type2 = (status = 'available', isPluggedIn = false) => ({
  connectorId: 1,
  connectorType: 'Type2',
  maxPowerKw: 22,
  status,
  isPluggedIn,
  energyDeliveredWh: null,
});

// The discussion 59 setup: a 1.6 ABL eM4 master with 7 extenders, 8 boxes of 2 AC EVSEs.
function em4(overrides: Partial<LayoutStation> = {}, boxes = 8): LayoutStation {
  return {
    id: 'sta_em4',
    stationId: 'ABL-EM4',
    model: 'eM4 Twin',
    status: 'available',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: bayToPosition({ col: 2, row: 0 }).x,
    positionY: bayToPosition({ col: 2, row: 0 }).y,
    placed: true,
    chargingKind: 'ac',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: Array.from({ length: boxes * 2 }, (_, i) => ({
      evseId: i + 1,
      status: 'available',
      unitId: `unt_${String(Math.floor(i / 2) + 1)}`,
      connectors: [type2()],
    })),
    units: Array.from({ length: boxes }, (_, i) => ({
      id: `unt_${String(i + 1)}`,
      name: `Box ${String(i + 1)}`,
      evseIds: [2 * i + 1, 2 * i + 2],
      boardPosition: i === 1 ? { x: 900, y: 40 } : null,
    })),
    boardPosition: { x: 5, y: 5 },
    ...overrides,
  };
}

const lot = effectiveLayoutSettings({
  siteType: 'parking_lot',
  spotsPerRow: 20,
  rows: 2,
  facingDeg: 0,
  chargerPlacement: 'islands',
  transformers: [],
});

describe('expandUnitStations', () => {
  it('returns a station without units as the same object (D3)', () => {
    const plain = em4({ units: [] });
    const [view] = expandUnitStations([plain], lot);
    expect(view).toBe(plain);
    const list = [plain, em4({ id: 'sta_2', units: undefined })];
    // A site without a station with units: the list as given.
    expect(layoutViewStations(list, lot)).toBe(list);
  });

  it('draws the 8 boxes as 8 chargers in one run of 16 spots, each with its own EVSEs', () => {
    const views = expandUnitStations([em4()], lot);
    expect(views.map((v) => v.id)).toEqual([
      'sta_em4',
      ...Array.from({ length: 7 }, (_, i) => `sta_em4#u${String(i + 2)}`),
    ]);
    expect(views.map((v) => positionToBay({ x: v.positionX, y: v.positionY }).col)).toEqual([
      2, 4, 6, 8, 10, 12, 14, 16,
    ]);
    expect(views[1]?.evses.map((e) => e.evseId)).toEqual([3, 4]);
    expect(views[1]?.unitCharger).toMatchObject({
      stationUuid: 'sta_em4',
      unitId: 'unt_2',
      name: 'Box 2',
      index: 1,
      offset: 2,
      spots: 2,
      stationKind: 'ac',
    });
    // Each unit charger pairs inside its own run, whatever the lot's column parity.
    expect(views.map((v) => unitPartnerCol(v))).toEqual([3, 5, 7, 9, 11, 13, 15, 17]);
    // Board cards: a unit's own, else the computed slot (the station row's card is not a unit's).
    expect(views[0]?.boardPosition).toBeNull();
    expect(views[1]?.boardPosition).toEqual({ x: 900, y: 40 });
  });

  it('adds a charger for the EVSEs without a unit, named by the station', () => {
    const station = em4();
    station.units = station.units?.slice(0, 2);
    const views = expandUnitStations([station], lot);
    expect(views).toHaveLength(3);
    const rest = views[2];
    expect(rest?.evses.map((e) => e.evseId)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(rest?.unitCharger?.unitId).toBeNull();
    expect(rest != null ? layoutChargerName(rest, t) : null).toBe('ABL-EM4');
    expect(views[1] != null ? layoutChargerName(views[1], t) : null).toBe('ABL-EM4, Box 2');
    // The rest charger keeps the station's own 2D card.
    expect(rest?.boardPosition).toEqual({ x: 5, y: 5 });
  });

  it('gives each unit its own bay or lane at a depot and its own curb post on a street', () => {
    // An AC box takes one spot at a depot; on a street each two-EVSE box is a
    // two-port curb post over two parallel spots (owner decision 2026-11-13).
    for (const [siteType, cols, spots] of [
      ['depot', [2, 3, 4], [1, 1, 1]],
      ['curbside', [2, 4, 6], [2, 2, 2]],
    ] as const) {
      const settings = effectiveLayoutSettings({ ...lot, siteType, busBays: 10, chargersLeft: 10 });
      const views = expandUnitStations([em4({}, 3)], settings);
      expect(views.map((v) => v.id)).toEqual(['sta_em4', 'sta_em4#u2', 'sta_em4#u3']);
      // Contiguous along the row from the station's slot (column 2).
      expect(views.map((v) => positionToBay({ x: v.positionX, y: v.positionY }).col)).toEqual(cols);
      expect(views.map((v) => v.unitCharger?.spots)).toEqual(spots);
      expect(views.map((v) => v.unitCharger?.number)).toEqual([1, 2, 3]);
      // A station without units stays the same object (D3).
      const plain = em4({ units: [] });
      expect(expandUnitStations([plain], settings)[0]).toBe(plain);
    }
  });

  it('gives a two-EVSE plug-in bus box at a depot two bays, a pantograph box one', () => {
    const depot = effectiveLayoutSettings({ ...lot, siteType: 'depot', busBays: 10 });
    const ccs = { ...type2(), connectorType: 'CCS1', maxPowerKw: 180 };
    const bus = em4({ evses: em4({}, 2).evses.map((e) => ({ ...e, connectors: [ccs] })) }, 2);
    expect(expandUnitStations([bus], depot).map((v) => v.unitCharger?.spots)).toEqual([2, 2]);
    const pan = { ...ccs, connectorType: 'Pan' };
    const poles = em4({ evses: em4({}, 2).evses.map((e) => ({ ...e, connectors: [pan] })) }, 2);
    expect(expandUnitStations([poles], depot).map((v) => v.unitCharger?.spots)).toEqual([1, 1]);
  });

  it('maps a view id back to its station', () => {
    expect(unitChargerViewId('sta_x', 0)).toBe('sta_x');
    expect(unitChargerViewId('sta_x', 3)).toBe('sta_x#u4');
    expect(layoutStationIdOf('sta_x#u4')).toBe('sta_x');
    expect(layoutStationIdOf('sta_x')).toBe('sta_x');
  });
});

describe('unit charger state (O4 A)', () => {
  it("shows the station's own state on every unit and its connectors' summary otherwise", () => {
    const evses = [{ evseId: 1, status: 'charging', connectors: [type2('charging', true)] }];
    expect(unitChargerStatus({ status: 'available', statusReason: null }, evses)).toBe('charging');
    expect(
      unitChargerStatus({ status: 'unavailable', statusReason: 'operator_disabled' }, evses),
    ).toBe('unavailable');
    expect(
      unitChargerStatus({ status: 'faulted', statusReason: 'connector_faulted' }, [
        { evseId: 1, status: 'available', connectors: [type2()] },
      ]),
    ).toBe('available');
    expect(unitChargerStatus({ status: 'x', statusReason: null }, [])).toBe('unknown');
  });

  it('keeps offline and maintenance on every unit charger', () => {
    const views = expandUnitStations([em4({ isOnline: false, inMaintenance: true })], lot);
    expect(views.every((v) => !v.isOnline && v.inMaintenance)).toBe(true);
  });

  it("gives each unit charger the session of its own EVSE, the station's when it is that one", () => {
    const station = em4({
      session: {
        id: 'ses_a',
        startedAt: '2026-11-11T08:00:00Z',
        energyDeliveredWh: 100,
        currentCostCents: 10,
        currency: 'EUR',
        driver: null,
        departure: null,
      },
    });
    const own = (id: string) => ({
      id,
      startedAt: '2026-11-11T08:00:00Z',
      energyDeliveredWh: 50,
      currentCostCents: null,
      currency: 'EUR',
      driver: null,
      vehicle: { color: 'red', bodyType: 'suv' },
    });
    station.evses[0] = { ...station.evses[0]!, session: own('ses_a') };
    station.evses[3] = { ...station.evses[3]!, session: own('ses_b') };
    const views = expandUnitStations([station], lot);
    expect(views[0]?.session).toBe(station.session);
    expect(views[1]?.session).toMatchObject({ id: 'ses_b', vehicle: { color: 'red' } });
    expect(views[2]?.session).toBeNull();
  });
});

describe('unit charger session fallback', () => {
  it('puts a station session no EVSE names on the first unit with a plug in', () => {
    const station = em4({
      session: {
        id: 'ses_x',
        startedAt: '2026-11-11T08:00:00Z',
        energyDeliveredWh: 10,
        currentCostCents: null,
        currency: 'EUR',
        driver: null,
      },
    });
    station.evses[5] = { ...station.evses[5]!, connectors: [type2('charging', true)] };
    const views = expandUnitStations([station], lot);
    expect(views.map((v) => v.session?.id ?? null)).toEqual([
      null,
      null,
      'ses_x',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('drops a retired EVSE from the unit chargers', () => {
    const station = em4({}, 2);
    station.evses[1] = { ...station.evses[1]!, retired: true };
    const views = expandUnitStations([station], lot);
    expect(views[0]?.evses.map((e) => e.evseId)).toEqual([1]);
    expect(views[0]?.unitCharger?.spots).toBe(1);
    expect(
      views[1] != null ? positionToBay({ x: views[1].positionX, y: views[1].positionY }).col : null,
    ).toBe(3);
  });

  it('counts a unit EVSE whose only connector is retired as no port, as the server does', () => {
    const station = em4({}, 2);
    station.evses[1] = {
      ...station.evses[1]!,
      connectors: [{ ...type2(), retired: true }],
    };
    const views = expandUnitStations([station], lot);
    expect(views[0]?.unitCharger?.spots).toBe(1);
    expect(layoutKindOfStation(station).ports).toBe(3);
  });

  it('reads a station without units with a retired second EVSE as one port, not a dual-port pedestal', () => {
    const plain = em4({ units: [] }, 1);
    plain.evses = plain.evses.map((e, i) => ({ ...e, unitId: null, retired: i === 1 }));
    expect(layoutKindOfStation(plain).ports).toBe(1);
  });
});

describe('unit terminals', () => {
  const term = (id: string, evseNumber: number | null): LayoutTerminal => ({
    id,
    name: id,
    stationId: 'sta_em4',
    evseNumber,
    hasDisplay: true,
    online: true,
  });

  it('shows a reader only on the unit of its EVSE, a whole-station one on the first', () => {
    const views = expandUnitStations([em4()], lot);
    const map = viewStationTerminals(
      views,
      new Map([['sta_em4', [term('pt_4', 4), term('pt_all', null)]]]),
    );
    expect(map.get('sta_em4')?.map((x) => x.id)).toEqual(['pt_all']);
    expect(map.get('sta_em4#u2')?.map((x) => x.id)).toEqual(['pt_4']);
    expect(map.has('sta_em4#u3')).toBe(false);
    // EVSE 4 is the second port of Box 2: its reader stands at that port.
    expect(views[1] != null ? chargerEvseNumber(views[1], 4) : null).toBe(2);
  });

  it('keeps the terminals and sides of a station without units', () => {
    const plain = em4({ units: [] });
    const map = viewStationTerminals([plain], new Map([['sta_em4', [term('pt', 1)]]]));
    expect(map.get('sta_em4')?.map((x) => x.id)).toEqual(['pt']);
    expect(chargerEvseNumber(plain, 7)).toBe(7);
  });
});

describe('custom site unit chargers', () => {
  const custom = effectiveLayoutSettings({ ...lot, siteType: 'custom' });
  it('places the unit chargers across the station car spots and moves the station by one', () => {
    const station = em4({ freePosition: { x: 10, z: 20, rotationDeg: 0 } }, 3);
    const views = layoutViewStations([station], custom);
    expect(views.map((v) => v.unitCharger?.spots)).toEqual([2, 2, 2]);
    const xs = views.map((v) => v.freePosition?.x);
    // Six car spots of 2.6 m centered on the station: the chargers at -5.2, 0 and 5.2 m.
    expect(xs).toEqual([4.8, 10, 15.2]);
    const unit = views[2]?.unitCharger;
    expect(unit).toBeDefined();
    if (unit != null) {
      expect(stationPlacementOfUnit(unit, { x: 25.2, z: 20, rotationDeg: 0 })).toEqual({
        x: 20,
        z: 20,
        rotationDeg: 0,
      });
    }
    // Siblings touch and never overlap: no resolution slides one of them.
    const places = freeStationPlaces(views);
    expect(views.map((v) => places.get(v.id)?.placement.x)).toEqual(xs);
  });

  it('gives every unit charger its own place past 16 spots (9 two-EVSE boxes and more)', () => {
    const station = em4({ freePosition: { x: 0, z: 20, rotationDeg: 0 } }, 12);
    const views = layoutViewStations([station], custom);
    const xs = views.map((v) => v.freePosition?.x);
    expect(new Set(xs).size).toBe(12);
    // 24 spots centered on the station: no charger falls back to the station center.
    expect(views.some((v) => v.unitCharger?.freeOffsetX === 0)).toBe(false);
  });
});

describe('unit charger links', () => {
  it('runs the station circuit on to every unit charger and leaves other circuits alone', () => {
    const panel: LinkPanel = {
      id: 'pnl',
      name: 'Panel',
      breakerRatingAmps: 400,
      maxContinuousKw: 200,
      childPanels: [],
      circuits: [
        {
          id: 'c1',
          name: 'C1',
          breakerRatingAmps: 100,
          maxContinuousKw: 50,
          stations: [{ id: 'sta_em4', allocatedLimitKw: 44 }],
        },
        {
          id: 'c2',
          name: 'C2',
          breakerRatingAmps: 40,
          maxContinuousKw: 7,
          stations: [{ id: 'sta_other', allocatedLimitKw: null }],
        },
      ],
    };
    const [routed] = withUnitChargers(
      [panel],
      new Map([['sta_em4', ['sta_em4', 'sta_em4#u2', 'sta_em4#u3']]]),
    );
    expect(routed?.circuits[0]?.stations).toEqual([
      { id: 'sta_em4', allocatedLimitKw: 44 },
      { id: 'sta_em4#u2', allocatedLimitKw: null },
      { id: 'sta_em4#u3', allocatedLimitKw: null },
    ]);
    expect(routed?.circuits[1]).toEqual(panel.circuits[1]);
    expect(withUnitChargers([panel], new Map())).toEqual([panel]);
  });
});

describe('unit chargers on a replayed day', () => {
  it('plugs each EVSE of a station with units in for the session that ran on it', () => {
    const station = em4({}, 2);
    const day: ReplayDay = {
      date: '2026-11-11',
      timezone: 'UTC',
      from: '2026-11-11T00:00:00Z',
      to: '2026-11-12T00:00:00Z',
      stations: [
        {
          id: 'sta_em4',
          initialOnline: true,
          onlineChanges: [],
          connectors: [],
          power: [],
          sessions: [
            {
              id: 'ses_1',
              startedAt: '2026-11-11T08:00:00Z',
              endedAt: '2026-11-11T10:00:00Z',
              energyWh: 2000,
              evseId: 1,
              driver: null,
              vehicle: { color: 'blue', bodyType: 'van' },
            },
            {
              id: 'ses_3',
              startedAt: '2026-11-11T08:30:00Z',
              endedAt: null,
              energyWh: 1000,
              evseId: 3,
              driver: null,
            },
          ],
        },
      ],
    };
    const at = Date.parse('2026-11-11T09:00:00Z');
    const frame = replayFrame(day, [station], at, Date.parse('2026-11-11T12:00:00Z'));
    const evses = frame.stations[0]?.evses ?? [];
    expect(evses.map((e) => e.session?.id ?? null)).toEqual(['ses_1', null, 'ses_3', null]);
    expect(evses.map((e) => e.connectors[0]?.isPluggedIn)).toEqual([true, false, true, false]);
    const views = expandUnitStations(frame.stations, lot);
    expect(views[0]?.session?.id).toBe('ses_1');
    expect(views[1]?.session?.id).toBe('ses_3');
  });

  it('replays a station without units with one car, on the EVSE its session ran on', () => {
    const station = em4({ units: [] }, 1);
    const day: ReplayDay = {
      date: '2026-11-11',
      timezone: 'UTC',
      from: '2026-11-11T00:00:00Z',
      to: '2026-11-12T00:00:00Z',
      stations: [
        {
          id: 'sta_em4',
          initialOnline: true,
          onlineChanges: [],
          connectors: [],
          power: [],
          sessions: [
            {
              id: 'ses_1',
              startedAt: '2026-11-11T08:00:00Z',
              endedAt: null,
              energyWh: 10,
              evseId: 2,
            },
          ],
        },
      ],
    };
    const frame = replayFrame(day, [station], Date.parse('2026-11-11T09:00:00Z'));
    const evses = frame.stations[0]?.evses ?? [];
    // Every station's EVSEs carry their own session, as the live layout's `evses[].session`.
    expect(evses.map((e) => e.session?.id ?? null)).toEqual([null, 'ses_1']);
    expect(evses.map((e) => e.connectors[0]?.isPluggedIn)).toEqual([false, true]);
  });
});

describe('unit charger thumbnails', () => {
  it('draws every two-EVSE AC box of the Lindenhof master as one dual-port charger, on a lot and a curb', () => {
    for (const settings of [
      lot,
      effectiveLayoutSettings({ ...lot, siteType: 'curbside', chargersLeft: 10 }),
    ]) {
      const views = expandUnitStations([em4()], settings);
      expect(views).toHaveLength(8);
      for (const v of views) {
        expect(v.evses.map((e) => e.evseId)).toHaveLength(2);
        expect(stationThumbnailModel(v, settings)).toBe('ac-pedestal-dual');
      }
    }
  });

  it('draws a DC unit with three EVSEs as one dispenser, never a split satellite', () => {
    const ccs = { ...type2(), connectorType: 'CCS2', maxPowerKw: 150 };
    const station = em4({
      chargingKind: 'dc',
      evses: [1, 2, 3].map((evseId) => ({
        evseId,
        status: 'available',
        unitId: 'unt_1',
        connectors: [ccs],
      })),
      units: [{ id: 'unt_1', name: 'DC Box', evseIds: [1, 2, 3] }],
    });
    const [view] = expandUnitStations([station], lot);
    expect(view != null ? stationThumbnailModel(view, lot) : null).toBe('dc-dispenser');
  });
});

describe('unit chargers and the two charger cases', () => {
  it('draws a two-EVSE box as one dual-port charger with a vehicle per EVSE from its own session', () => {
    const session = (id: string) => ({
      id,
      startedAt: '2026-11-11T08:00:00.000Z',
      energyDeliveredWh: 100,
      currentCostCents: null,
      currency: 'EUR',
      driver: null,
      vehicle: null,
    });
    const station = em4({}, 1);
    const both = {
      ...station,
      evses: station.evses.map((e) => ({
        ...e,
        session: e.evseId === 2 ? session('ses_2') : null,
        connectors: [type2(e.evseId === 1 ? 'preparing' : 'charging', true)],
      })),
    };
    const [view] = expandUnitStations([both], lot);
    if (view == null) throw new Error('no view');
    expect(view.unitCharger?.spots).toBe(2);
    expect(drawnEvseConnectors('ac', view.evses, false)).toEqual([1, 1]);
    const plugs = stationPlugs({
      evses: view.evses,
      drawn: [1, 1],
      stallCount: 2,
      carShown: true,
      carOf: (i) => view.evses[i]?.session?.id ?? `default-${String(i)}`,
    });
    // EVSE 1 has a cable in before its session: its own default car, never EVSE 2's car twice.
    expect(plugs.stallCars).toEqual(['default-0', 'ses_2']);
    expect(plugs.plugged).toEqual([0, 0]);
  });

  it('draws a box of one CCS2 and CHAdeMO EVSE as one dispenser with both holsters and one stall', () => {
    const ccs = { ...type2(), connectorType: 'CCS2', maxPowerKw: 150 };
    const chademo = { ...type2('charging', true), connectorId: 2, connectorType: 'CHAdeMO' };
    const station = em4({
      chargingKind: 'dc',
      evses: [{ evseId: 1, status: 'charging', unitId: 'unt_1', connectors: [ccs, chademo] }],
      units: [{ id: 'unt_1', name: 'DC Box', evseIds: [1] }],
    });
    const [view] = expandUnitStations([station], lot);
    if (view == null) throw new Error('no view');
    expect(stationThumbnailModel(view, lot)).toBe('dc-dispenser');
    expect(view.unitCharger?.spots).toBe(1);
    const drawn = drawnEvseConnectors('dc', view.evses, false);
    expect(drawn).toEqual([2]);
    const plugs = stationPlugs({
      evses: view.evses,
      drawn,
      stallCount: 1,
      carShown: true,
      carOf: () => 'car',
    });
    expect(plugs.stallCars).toBeUndefined();
    expect(plugs.plugged).toEqual([1]);
  });
});
