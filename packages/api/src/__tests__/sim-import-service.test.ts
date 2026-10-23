// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The SIM CSV import, export and template (`services/sim-import.service.ts`)
// with the reads and the inventory service mocked: the row checks, the
// per-row results, the inactive SIM refusal, the export filters and
// scope and the formula neutralisation. The SQL, the savepoint
// rollback of a refused row and the audit rows run in integration 136.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getSimByIccid: vi.fn<(iccid: string) => Promise<unknown>>(async () => null),
  stationByOcppId: vi.fn<(ocppId: string) => Promise<{ id: string } | null>>(async () => null),
  exportSimViews: vi.fn(async () => [] as unknown[]),
  ensureSim: vi.fn(),
  updateSim: vi.fn(),
  attachSim: vi.fn(),
  savepoints: 0,
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const tx = {
    transaction: async (fn: (inner: unknown) => Promise<unknown>) => {
      m.savepoints += 1;
      return fn(tx);
    },
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getSimByIccid: m.getSimByIccid,
    db: { transaction: async (fn: (inner: unknown) => Promise<unknown>) => fn(tx) },
  };
});

vi.mock('../lib/sim-views.js', () => ({
  exportSimViews: m.exportSimViews,
  stationByOcppId: m.stationByOcppId,
}));

vi.mock('@evtivity/services/sim-inventory.service', () => ({
  ensureSim: m.ensureSim,
  updateSim: m.updateSim,
  attachSim: m.attachSim,
}));

import {
  exportSimsCsv,
  exportSimTemplateCsv,
  importSimsCsv,
  SIM_CSV_HEADER,
} from '../services/sim-import.service.js';

const ACTOR = { audit: { actor: 'operator' as const, actorUserId: 'usr_1' }, userId: 'usr_1' };
const ICCID = '8900000000000001361';
const ICCID_2 = '8900000000000001362';
const BOM = '﻿';

function sim(id: string, status: 'active' | 'inactive' = 'active') {
  return { id, status, label: null, notes: null, imsi: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.savepoints = 0;
  m.getSimByIccid.mockResolvedValue(null);
  m.stationByOcppId.mockResolvedValue(null);
  m.ensureSim.mockImplementation(async () => ({ sim: sim('sim_new'), created: true }));
  m.updateSim.mockImplementation(async (id: string) => ({
    before: sim(id),
    after: { ...sim(id), label: 'changed' },
  }));
  m.attachSim.mockResolvedValue({ kind: 'attached', attachment: { id: 1 } });
});

describe('template', () => {
  it('has the CSV header, the CSMS status apart from the provider state, and example rows', () => {
    const csv = exportSimTemplateCsv();
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(SIM_CSV_HEADER.join(','));
    expect(SIM_CSV_HEADER.slice(0, 5)).toEqual(['iccid', 'imsi', 'label', 'notes', 'stationId']);
    expect(SIM_CSV_HEADER).toContain('status');
    expect(SIM_CSV_HEADER).toContain('providerState');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.split(',')).toHaveLength(SIM_CSV_HEADER.length);
    }
  });
});

describe('export', () => {
  it('passes the list filters and the user scope, and writes one line per SIM', async () => {
    m.exportSimViews.mockResolvedValue([
      {
        iccid: ICCID,
        imsi: '310260000000001',
        label: '=HYPERLINK("x")',
        notes: 'a, b',
        status: 'inactive',
        provider: 'hologram',
        lastStatus: { state: 'active' },
        attachment: { stationId: 'sta_1', stationOcppId: 'CS-1', confirmed: true },
      },
      {
        iccid: ICCID_2,
        imsi: null,
        label: null,
        notes: null,
        status: 'active',
        provider: null,
        lastStatus: null,
        attachment: null,
      },
    ]);
    const csv = await exportSimsCsv({ provider: 'hologram', status: 'inactive' }, ['sit_a']);
    expect(m.exportSimViews).toHaveBeenCalledWith({ provider: 'hologram', status: 'inactive' }, [
      'sit_a',
    ]);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      `${ICCID},310260000000001,"'=HYPERLINK(""x"")","a, b",CS-1,inactive,hologram,active,sta_1,true`,
    );
    expect(lines[2]).toBe(`${ICCID_2},,,,,active,,,,`);
  });

  it('exports every SIM the user sees with no filter', async () => {
    await exportSimsCsv({}, null);
    expect(m.exportSimViews).toHaveBeenCalledWith({}, null);
  });
});

describe('import', () => {
  it('creates a SIM with its fields and attaches it imported to the named station', async () => {
    m.stationByOcppId.mockResolvedValue({ id: 'sta_1' });
    const result = await importSimsCsv(
      [{ iccid: ICCID, imsi: '310260000000001', label: 'Depot', stationId: 'CS-1' }],
      false,
      ACTOR,
    );
    expect(result).toEqual({ created: 1, updated: 0, attached: 1, errors: [] });
    // The fields go into the insert: one `created` audit row, no update.
    expect(m.ensureSim).toHaveBeenCalledWith(
      ICCID,
      expect.objectContaining({
        actor: ACTOR,
        notes: 'CSV import',
        fields: { imsi: '310260000000001', label: 'Depot' },
      }),
      expect.anything(),
    );
    expect(m.updateSim).not.toHaveBeenCalled();
    expect(m.attachSim).toHaveBeenCalledWith(
      'sim_new',
      'sta_1',
      expect.objectContaining({ source: 'imported', notes: 'CSV import' }),
      expect.anything(),
    );
  });

  it('skips an existing SIM without updateExisting', async () => {
    m.getSimByIccid.mockResolvedValue(sim('sim_old'));
    const result = await importSimsCsv([{ iccid: ICCID, label: 'x' }], false, ACTOR);
    expect(result.errors).toEqual(['Row 1: SIM already exists, skipped']);
    expect(result.created + result.updated).toBe(0);
    expect(m.updateSim).not.toHaveBeenCalled();
  });

  it('updates an existing SIM with updateExisting and counts only a change', async () => {
    m.getSimByIccid.mockResolvedValue(sim('sim_old'));
    const changed = await importSimsCsv([{ iccid: ICCID, label: 'x' }], true, ACTOR);
    expect(changed).toEqual({ created: 0, updated: 1, attached: 0, errors: [] });
    expect(m.ensureSim).not.toHaveBeenCalled();
    // The writer returns `before` as `after` when nothing changed.
    m.updateSim.mockImplementation(async (id: string) => {
      const same = sim(id);
      return { before: same, after: same };
    });
    const same = await importSimsCsv([{ iccid: ICCID, label: 'x' }], true, ACTOR);
    expect(same.updated).toBe(0);
  });

  it('keeps a field whose cell is empty', async () => {
    m.getSimByIccid.mockResolvedValue(sim('sim_old'));
    await importSimsCsv([{ iccid: ICCID, imsi: '', label: ' ', notes: 'n' }], true, ACTOR);
    expect(m.updateSim).toHaveBeenCalledWith(
      'sim_old',
      { notes: 'n' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses invalid rows one by one and imports the others', async () => {
    const result = await importSimsCsv(
      [
        { iccid: 'not-an-iccid' },
        { iccid: ICCID, imsi: '12ab' },
        { iccid: ICCID, label: 'x'.repeat(101) },
        { iccid: ICCID, notes: 'x'.repeat(2001) },
        { iccid: ICCID_2 },
        { iccid: `${ICCID_2}F` },
      ],
      false,
      ACTOR,
    );
    expect(result.errors).toEqual([
      'Row 1: invalid ICCID',
      'Row 2: invalid IMSI (up to 15 digits)',
      'Row 3: label longer than 100 characters',
      'Row 4: notes longer than 2000 characters',
      'Row 6: duplicate ICCID in the file',
    ]);
    expect(result.created).toBe(1);
  });

  it('treats a SIM another writer created meanwhile as existing: skipped, or updated', async () => {
    m.ensureSim.mockImplementation(async () => ({ sim: sim('sim_race'), created: false }));
    const skipped = await importSimsCsv([{ iccid: ICCID, label: 'x' }], false, ACTOR);
    expect(skipped).toEqual({
      created: 0,
      updated: 0,
      attached: 0,
      errors: ['Row 1: SIM already exists, skipped'],
    });
    expect(m.updateSim).not.toHaveBeenCalled();
    const updated = await importSimsCsv([{ iccid: ICCID, label: 'x' }], true, ACTOR);
    expect(updated).toEqual({ created: 0, updated: 1, attached: 0, errors: [] });
    expect(m.updateSim).toHaveBeenCalledWith(
      'sim_race',
      { label: 'x' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses an unknown station before anything is written', async () => {
    const result = await importSimsCsv([{ iccid: ICCID, stationId: 'CS-X' }], false, ACTOR);
    expect(result.errors).toEqual(['Row 1: station "CS-X" not found']);
    expect(m.ensureSim).not.toHaveBeenCalled();
  });

  it.each([
    ['station_has_sim', 'Row 1: station "CS-1" already has another SIM'],
    ['sim_attached_elsewhere', 'Row 1: SIM is attached to another station'],
    ['sim_inactive', 'Row 1: SIM is inactive, not attached'],
    ['sim_not_found', 'Row 1: SIM not found'],
  ])('refuses the row when the attach answers %s, nothing counted', async (kind, error) => {
    m.stationByOcppId.mockResolvedValue({ id: 'sta_1' });
    m.attachSim.mockResolvedValue({ kind });
    const result = await importSimsCsv(
      [{ iccid: ICCID, label: 'x', stationId: 'CS-1' }],
      true,
      ACTOR,
    );
    expect(result).toEqual({ created: 0, updated: 0, attached: 0, errors: [error] });
    // The row ran in its own savepoint, rolled back by the refusal.
    expect(m.savepoints).toBe(1);
  });

  it('counts no attach when the SIM is already at the station', async () => {
    m.getSimByIccid.mockResolvedValue(sim('sim_old'));
    m.stationByOcppId.mockResolvedValue({ id: 'sta_1' });
    m.attachSim.mockResolvedValue({ kind: 'unchanged', attachment: { id: 1 } });
    const result = await importSimsCsv([{ iccid: ICCID, stationId: 'CS-1' }], true, ACTOR);
    expect(result).toEqual({ created: 0, updated: 0, attached: 0, errors: [] });
  });
});
