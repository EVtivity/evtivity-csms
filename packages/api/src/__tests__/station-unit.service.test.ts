// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createStationUnit: vi.fn(),
  updateStationUnit: vi.fn(),
  deleteStationUnit: vi.fn(),
  setEvseUnit: vi.fn(),
  readStationUnits: vi.fn(),
  writeAudit: vi.fn(),
  publishStationStatusChanged: vi.fn(),
  refitStationRun: vi.fn(),
  selectRows: [] as unknown[][],
}));

vi.mock('@evtivity/database', () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const k of ['from', 'where']) c[k] = vi.fn(() => c);
    c['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(m.selectRows.shift() ?? []).then(resolve);
    return c;
  };
  return {
    STATION_UNIT_NAME_MAX: 50,
    STATION_UNIT_SERIAL_MAX: 64,
    STATION_UNITS_MAX: 64,
    chargingStations: { id: 'id', siteId: 'site_id' },
    evses: { id: 'id', evseId: 'evse_id', stationId: 'station_id' },
    stationAuditLog: {},
    siteAuditLog: { site: true },
    db: {
      select: vi.fn(() => chain()),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
    refitStationRun: m.refitStationRun,
    createStationUnit: m.createStationUnit,
    updateStationUnit: m.updateStationUnit,
    deleteStationUnit: m.deleteStationUnit,
    setEvseUnit: m.setEvseUnit,
    readStationUnits: m.readStationUnits,
    writeAudit: m.writeAudit,
  };
});
vi.mock('../lib/station-status-events.js', () => ({
  publishStationStatusChanged: m.publishStationStatusChanged,
}));

import {
  assignEvseUnit,
  checkUnitDetails,
  createUnit,
  deleteUnit,
  updateUnit,
} from '../services/station-unit.service.js';

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: log as never,
};
const UNIT = { id: 'unt_1', stationId: 'sta_1', name: 'Box 1', sortOrder: 0 };
const VIEW = { ...UNIT, evseIds: ['evs_1'], evseNumbers: [1] };

beforeEach(() => {
  vi.clearAllMocks();
  m.selectRows = [];
  m.readStationUnits.mockResolvedValue([VIEW]);
  m.refitStationRun.mockResolvedValue(null);
});

describe('station unit service', () => {
  it('creates a unit, writes one history row and announces the station', async () => {
    m.selectRows = [[{ id: 'evs_1', evseId: 1 }], [{ siteId: 'sit_1' }]];
    m.createStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: true,
      before: null,
      after: { id: 'unt_1', name: 'Box 1', evseIds: [1] },
    });
    const view = await createUnit('sta_1', { name: ' Box 1 ', evseIds: [1] }, ctx);
    expect(view).toEqual(VIEW);
    expect(m.createStationUnit).toHaveBeenCalledWith('sta_1', {
      name: ' Box 1 ',
      evseIds: ['evs_1'],
    });
    expect(m.writeAudit).toHaveBeenCalledTimes(1);
    const row = m.writeAudit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(row).toMatchObject({
      action: 'unit_changed',
      before: null,
      after: { unit: { id: 'unt_1', name: 'Box 1', evseIds: [1] } },
      notes: 'Unit created',
      actorUserId: 'usr_1',
    });
    expect(m.publishStationStatusChanged).toHaveBeenCalledWith(
      { id: 'sta_1', siteId: 'sit_1' },
      log,
      { dashboardsOnly: false },
    );
  });

  it('refuses a name with control, bidi or zero-width characters before writing', async () => {
    for (const name of ['Box\n1', 'Box‮1', 'Box​1', '   ', 'x'.repeat(51)]) {
      await expect(createUnit('sta_1', { name }, ctx)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    expect(m.createStationUnit).not.toHaveBeenCalled();
  });

  it('checks the serial number and stores the IP address in canonical form', () => {
    expect(checkUnitDetails({})).toEqual({});
    expect(checkUnitDetails({ serialNumber: ' EM4-0001 ', ipAddress: ' 192.168.1.21 ' })).toEqual({
      serialNumber: 'EM4-0001',
      ipAddress: '192.168.1.21',
    });
    expect(checkUnitDetails({ ipAddress: '2001:0DB8:0:0:0:0:0:0001' })).toEqual({
      ipAddress: '2001:db8::1',
    });
    // An empty or blank value, or null, clears the field.
    expect(checkUnitDetails({ serialNumber: '  ', ipAddress: '' })).toEqual({
      serialNumber: null,
      ipAddress: null,
    });
    expect(checkUnitDetails({ serialNumber: null, ipAddress: null })).toEqual({
      serialNumber: null,
      ipAddress: null,
    });
  });

  it('refuses an invalid IP address or serial number with the field, before writing', async () => {
    for (const ipAddress of [
      'charger.local',
      '192.168.1.21:8080',
      '192.168.1.0/24',
      '300.1.1.1',
      'fe80::1%eth0',
      '[2001:db8::1]',
    ]) {
      await expect(createUnit('sta_1', { name: 'Box 1', ipAddress }, ctx)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { field: 'ipAddress' },
      });
    }
    for (const serialNumber of ['SN\n1', 'SN\u202e1', 'SN\u200b1', 'x'.repeat(65)]) {
      await expect(updateUnit('sta_1', 'unt_1', { serialNumber }, ctx)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { field: 'serialNumber' },
      });
    }
    expect(m.createStationUnit).not.toHaveBeenCalled();
    expect(m.updateStationUnit).not.toHaveBeenCalled();
  });

  it('passes the checked details to the writer and notes a details change', async () => {
    m.selectRows = [[], [{ siteId: 'sit_1' }]];
    m.createStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: true,
      before: null,
      after: {
        id: 'unt_1',
        name: 'Box 1',
        serialNumber: 'SN1',
        ipAddress: '10.0.0.5',
        evseIds: [],
      },
    });
    await createUnit('sta_1', { name: 'Box 1', serialNumber: 'SN1', ipAddress: '10.0.0.5' }, ctx);
    expect(m.createStationUnit).toHaveBeenCalledWith('sta_1', {
      name: 'Box 1',
      evseIds: [],
      serialNumber: 'SN1',
      ipAddress: '10.0.0.5',
    });
    m.updateStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: true,
      before: {
        id: 'unt_1',
        name: 'Box 1',
        serialNumber: 'SN1',
        ipAddress: '10.0.0.5',
        evseIds: [],
      },
      after: { id: 'unt_1', name: 'Box 1', serialNumber: null, ipAddress: '10.0.0.6', evseIds: [] },
      fields: ['serialNumber', 'ipAddress'],
    });
    await updateUnit('sta_1', 'unt_1', { serialNumber: '', ipAddress: '10.0.0.6' }, ctx);
    expect(m.updateStationUnit).toHaveBeenCalledWith('sta_1', 'unt_1', {
      serialNumber: null,
      ipAddress: '10.0.0.6',
    });
    const update = m.writeAudit.mock.calls[1]?.[1] as {
      notes: string;
      before: { unit: { serialNumber: string | null } };
      after: { unit: { serialNumber: string | null; ipAddress: string | null } };
    };
    expect(update.notes).toBe('Unit details changed');
    expect(update.before.unit.serialNumber).toBe('SN1');
    expect(update.after.unit).toMatchObject({ serialNumber: null, ipAddress: '10.0.0.6' });
    // Admin metadata reaches neither partners nor drivers: dashboards only, no layout refit.
    expect(m.publishStationStatusChanged).toHaveBeenLastCalledWith(expect.anything(), log, {
      dashboardsOnly: true,
    });
    expect(m.refitStationRun).toHaveBeenCalledTimes(1);
  });

  it('names every field a combined update changed', async () => {
    m.updateStationUnit.mockResolvedValue({
      ok: true,
      value: { ...UNIT, name: 'Box 9' },
      changed: true,
      before: { id: 'unt_1', name: 'Box 1', evseIds: [1] },
      after: { id: 'unt_1', name: 'Box 9', evseIds: [1] },
      fields: ['name', 'serialNumber', 'sortOrder'],
    });
    await updateUnit('sta_1', 'unt_1', { name: 'Box 9', serialNumber: 'SN9', sortOrder: 3 }, ctx);
    expect((m.writeAudit.mock.calls[0]?.[1] as { notes: string }).notes).toBe(
      'Unit renamed, details changed and moved in the order',
    );
    expect(m.publishStationStatusChanged).toHaveBeenCalledWith(expect.anything(), log, {
      dashboardsOnly: false,
    });
  });

  it('writes a history row for each unit a new unit took EVSEs from', async () => {
    m.selectRows = [
      [
        { id: 'evs_3', evseId: 3 },
        { id: 'evs_4', evseId: 4 },
      ],
      [{ siteId: 'sit_1' }],
    ];
    m.readStationUnits.mockResolvedValue([{ ...VIEW, id: 'unt_9', name: 'Box 9' }]);
    m.createStationUnit.mockResolvedValue({
      ok: true,
      value: { ...UNIT, id: 'unt_9', name: 'Box 9' },
      changed: true,
      before: null,
      after: { id: 'unt_9', name: 'Box 9', evseIds: [3, 4] },
      left: [
        {
          before: { id: 'unt_2', name: 'Box 2', evseIds: [3, 4] },
          after: { id: 'unt_2', name: 'Box 2', evseIds: [] },
        },
      ],
    });
    await createUnit('sta_1', { name: 'Box 9', evseIds: [3, 4] }, ctx);
    const rows = m.writeAudit.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(rows.map((r) => r['notes'])).toEqual([
      'Unit created',
      'EVSE 3 and 4 moved to unit Box 9',
    ]);
    expect(rows[1]).toMatchObject({
      before: { unit: { id: 'unt_2', evseIds: [3, 4] } },
      after: { unit: { id: 'unt_2', evseIds: [] } },
    });
  });

  it('maps the writer refusals to API errors', async () => {
    const cases: [string, string, number][] = [
      ['station_not_found', 'STATION_NOT_FOUND', 404],
      ['not_found', 'STATION_UNIT_NOT_FOUND', 404],
      ['evse_not_found', 'EVSE_NOT_FOUND', 404],
      ['name_in_use', 'STATION_UNIT_NAME_IN_USE', 409],
      ['limit', 'STATION_UNIT_LIMIT_REACHED', 400],
      ['other_station', 'VALIDATION_ERROR', 400],
    ];
    for (const [reason, code, statusCode] of cases) {
      m.updateStationUnit.mockResolvedValueOnce({ ok: false, reason });
      await expect(updateUnit('sta_1', 'unt_1', { name: 'Box 2' }, ctx)).rejects.toMatchObject({
        code,
        statusCode,
      });
    }
    expect(m.writeAudit).not.toHaveBeenCalled();
  });

  it('audits and announces nothing for a write that changed nothing', async () => {
    const same = { id: 'unt_1', name: 'Box 1', evseIds: [1] };
    m.updateStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: false,
      before: same,
      after: same,
    });
    await updateUnit('sta_1', 'unt_1', { name: 'Box 1' }, ctx);
    m.selectRows = [[{ id: 'evs_1' }]];
    m.setEvseUnit.mockResolvedValue({
      ok: true,
      value: null,
      changed: false,
      before: same,
      after: same,
    });
    expect(await assignEvseUnit('sta_1', 1, 'unt_1', ctx)).toEqual({ changed: false });
    expect(m.writeAudit).not.toHaveBeenCalled();
    expect(m.publishStationStatusChanged).not.toHaveBeenCalled();
  });

  it('names the rename and the EVSE moves in the history notes', async () => {
    m.updateStationUnit.mockResolvedValue({
      ok: true,
      value: { ...UNIT, name: 'Box 9' },
      changed: true,
      before: { id: 'unt_1', name: 'Box 1', evseIds: [1] },
      after: { id: 'unt_1', name: 'Box 9', evseIds: [1] },
      fields: ['name'],
    });
    await updateUnit('sta_1', 'unt_1', { name: 'Box 9' }, ctx);
    m.selectRows = [[{ id: 'evs_2' }]];
    m.setEvseUnit.mockResolvedValue({
      ok: true,
      value: null,
      changed: true,
      before: null,
      after: { id: 'unt_1', name: 'Box 9', evseIds: [1, 2] },
    });
    await assignEvseUnit('sta_1', 2, 'unt_1', ctx);
    m.selectRows = [[{ id: 'evs_2' }]];
    m.setEvseUnit.mockResolvedValue({
      ok: true,
      value: null,
      changed: true,
      before: { id: 'unt_1', name: 'Box 9', evseIds: [1] },
      after: null,
    });
    await assignEvseUnit('sta_1', 2, null, ctx);
    m.deleteStationUnit.mockResolvedValue({
      ok: true,
      value: null,
      changed: true,
      before: { id: 'unt_1', name: 'Box 9', evseIds: [1] },
      after: null,
    });
    await deleteUnit('sta_1', 'unt_1', ctx);
    expect(m.writeAudit.mock.calls.map((c) => (c[1] as { notes: string }).notes)).toEqual([
      'Unit renamed',
      'EVSE 2 moved to a unit',
      'EVSE 2 removed from its unit',
      'Unit deleted',
    ]);
  });

  it('answers EVSE_NOT_FOUND for an EVSE number the station does not have', async () => {
    m.selectRows = [[]];
    await expect(assignEvseUnit('sta_1', 9, 'unt_1', ctx)).rejects.toMatchObject({
      code: 'EVSE_NOT_FOUND',
    });
    m.selectRows = [[{ id: 'evs_1', evseId: 1 }]];
    await expect(createUnit('sta_1', { name: 'Box 2', evseIds: [7] }, ctx)).rejects.toMatchObject({
      code: 'EVSE_NOT_FOUND',
    });
  });

  it('keeps the change when the site read or the announcement fails', async () => {
    m.updateStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: true,
      before: { id: 'unt_1', name: 'Box 1', evseIds: [] },
      after: { id: 'unt_1', name: 'Box 2', evseIds: [] },
    });
    m.selectRows = [];
    m.publishStationStatusChanged.mockResolvedValueOnce(undefined);
    await expect(updateUnit('sta_1', 'unt_1', { name: 'Box 2' }, ctx)).resolves.toEqual(VIEW);
  });

  it('moves the station on its layout when its run no longer fits, audited on the site', async () => {
    m.selectRows = [[{ id: 'evs_1', evseId: 1 }], [{ siteId: 'sit_1' }]];
    m.createStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: true,
      before: null,
      after: { id: 'unt_1', name: 'Box 1', evseIds: [1] },
    });
    const before = { stationId: 'sta_1', positionX: 1620, positionY: 20 };
    const after = { stationId: 'sta_1', positionX: 20, positionY: 160 };
    m.refitStationRun.mockResolvedValueOnce({ stationId: 'sta_1', siteId: 'sit_1', before, after });
    await createUnit('sta_1', { name: 'Box 1', evseIds: [1] }, ctx);
    expect(m.refitStationRun).toHaveBeenCalledWith({}, 'sta_1');
    const site = m.writeAudit.mock.calls.find(
      (c) => (c[0] as { idColumn: string }).idColumn === 'site_id',
    );
    expect(site?.[1]).toMatchObject({
      entityId: 'sit_1',
      action: 'updated',
      before: { layoutPositions: [before] },
      after: { layoutPositions: [after] },
      notes: 'station layout moved for its units',
    });
  });

  it('keeps the unit change when the layout refit fails', async () => {
    m.selectRows = [[{ id: 'evs_1', evseId: 1 }], [{ siteId: 'sit_1' }]];
    m.createStationUnit.mockResolvedValue({
      ok: true,
      value: UNIT,
      changed: true,
      before: null,
      after: { id: 'unt_1', name: 'Box 1', evseIds: [1] },
    });
    m.refitStationRun.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(createUnit('sta_1', { name: 'Box 1', evseIds: [1] }, ctx)).resolves.toMatchObject({
      id: 'unt_1',
    });
    expect(log.warn).toHaveBeenCalled();
    expect(m.publishStationStatusChanged).toHaveBeenCalled();
  });
});
