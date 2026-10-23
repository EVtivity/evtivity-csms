// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openStationAttachment: vi.fn(),
  openSimAttachment: vi.fn(),
  closeAttachment: vi.fn(),
  attachSimToStation: vi.fn(),
  confirmAttachment: vi.fn(),
  findOrCreateSimRecord: vi.fn(),
  getSim: vi.fn(),
  getSimByIccid: vi.fn(),
  updateSimFields: vi.fn(),
  /** The station ids of each data plan push wrap, in call order. */
  planPushes: [] as Array<Array<string | null | undefined>>,
  deleteSim: vi.fn(),
  setSimStatus: vi.fn(),
  writeAudit: vi.fn(),
  stationIccid: {
    value: null as string | null,
    source: 'reported',
    enteredBy: null as string | null,
    enteredWithAllSites: false,
  },
  /** The entering person as the users table holds them now. */
  enteringUser: { hasAllSiteAccess: true, isActive: true },
  /** Station updates: the values set and the station they were for. */
  stationUpdates: [] as Array<Record<string, unknown>>,
  /** The transaction depth of each station update (0 is the default executor). */
  stationUpdateDepths: [] as number[],
}));

vi.mock('@evtivity/database', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/database')>('@evtivity/database');
  const chain = {
    from: () => chain,
    where: () =>
      Promise.resolve([
        {
          iccid: mocks.stationIccid.value,
          source: mocks.stationIccid.source,
          enteredBy: mocks.stationIccid.enteredBy,
          enteredWithAllSites: mocks.stationIccid.enteredWithAllSites,
          hasAllSiteAccess: mocks.enteringUser.hasAllSiteAccess,
          isActive: mocks.enteringUser.isActive,
        },
      ]),
  };
  const update = (depth: number) => () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        mocks.stationUpdates.push(values);
        mocks.stationUpdateDepths.push(depth);
        return Promise.resolve();
      },
    }),
  });
  // Each transaction (a savepoint when nested) gets its own executor with its depth.
  const executor = (depth: number): Record<string, unknown> => {
    const tx: Record<string, unknown> = { depth, select: () => chain, update: update(depth) };
    tx['transaction'] = (fn: (inner: unknown) => Promise<unknown>) => fn(executor(depth + 1));
    return tx;
  };
  const dbMock = executor(0);
  return {
    db: dbMock,
    chargingStations: {
      id: 'id',
      iccid: 'iccid',
      iccidSource: 'iccid_source',
      iccidEnteredBy: 'iccid_entered_by',
      iccidEnteredWithAllSites: 'iccid_entered_with_all_sites',
    },
    simAuditLog: { name: 'sim_audit_log' },
    users: { id: 'id', hasAllSiteAccess: 'has_all_site_access', isActive: 'is_active' },
    stationAuditLog: { name: 'station_audit_log' },
    attachmentOutcome: actual.attachmentOutcome,
    openStationAttachment: mocks.openStationAttachment,
    openSimAttachment: mocks.openSimAttachment,
    closeAttachment: mocks.closeAttachment,
    attachSimToStation: mocks.attachSimToStation,
    confirmAttachment: mocks.confirmAttachment,
    findOrCreateSimRecord: mocks.findOrCreateSimRecord,
    getSim: mocks.getSim,
    getSimByIccid: mocks.getSimByIccid,
    updateSimFields: mocks.updateSimFields,
    deleteSim: mocks.deleteSim,
    setSimStatus: mocks.setSimStatus,
    writeAudit: mocks.writeAudit,
  };
});

vi.mock('../station-data-plan.service.js', () => ({
  withStationDataPlanPush: (
    stationIds: Array<string | null | undefined>,
    run: () => Promise<unknown>,
  ) => {
    mocks.planPushes.push(stationIds);
    return run();
  },
}));

const service = await import('../sim-inventory.service.js');
const { db: dbExecutor } = await import('@evtivity/database');
const {
  attachReportedStationSim,
  attachSim,
  closeStationAttachmentOnIccidChange,
  confirmStationAttachment,
  deactivateSim,
  deleteSim,
  detachStationSim,
  enterStationIccid,
  reactivateSim,
  updateSim,
} = service;

const ICCID = '8900000000000000300';
const OTHER_ICCID = '8900000000000000318';
const ACTOR = { audit: { actor: 'operator' as const, actorUserId: 'usr_1' }, userId: 'usr_1' };

function attachment(fields: Record<string, unknown> = {}) {
  return {
    id: 7,
    simId: 'sim_abc',
    stationId: 'sta_1',
    paymentTerminalId: null,
    source: 'reported',
    attachedAt: new Date('2026-10-20T00:00:00Z'),
    attachedBy: null,
    attachedWithAllSites: false,
    confirmedAt: null,
    confirmedBy: null,
    detachedAt: null,
    detachedBy: null,
    detachReason: null,
    ...fields,
  };
}

function sim(fields: Record<string, unknown> = {}) {
  return {
    id: 'sim_abc',
    iccid: ICCID,
    imsi: null,
    provider: null,
    providerRef: null,
    providerMeta: null,
    label: null,
    notes: null,
    status: 'active',
    deactivatedAt: null,
    deactivatedBy: null,
    ...fields,
  };
}

function auditCalls(): Array<{ table: string; args: Record<string, unknown> }> {
  return mocks.writeAudit.mock.calls.map((call) => ({
    table: (call[0] as { idColumn: string }).idColumn,
    args: call[1] as Record<string, unknown>,
  }));
}

function closedAs(reason: string) {
  return (id: number) =>
    Promise.resolve(attachment({ id, detachedAt: new Date(), detachReason: reason }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAudit.mockReset();
  mocks.stationIccid.value = ICCID;
  mocks.stationIccid.source = 'reported';
  mocks.stationIccid.enteredBy = null;
  mocks.stationIccid.enteredWithAllSites = false;
  mocks.enteringUser.hasAllSiteAccess = true;
  mocks.enteringUser.isActive = true;
  mocks.stationUpdates.length = 0;
  mocks.stationUpdateDepths.length = 0;
  mocks.planPushes.length = 0;
  mocks.getSimByIccid.mockResolvedValue(null);
  mocks.findOrCreateSimRecord.mockResolvedValue({ sim: sim(), created: false });
  mocks.openStationAttachment.mockResolvedValue(null);
  mocks.openSimAttachment.mockResolvedValue(null);
  mocks.closeAttachment.mockImplementation((id: number, reason: string) => closedAs(reason)(id));
});

describe('closeStationAttachmentOnIccidChange', () => {
  it('changes nothing for a station without an open attachment', async () => {
    expect(await closeStationAttachmentOnIccidChange('sta_1', OTHER_ICCID)).toBe(false);
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('closes the open attachment iccid_changed and writes the SIM and station audit rows', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment({ confirmedAt: new Date() }));
    mocks.getSim.mockResolvedValue(sim());
    expect(await closeStationAttachmentOnIccidChange('sta_1', OTHER_ICCID)).toBe(true);
    expect(mocks.closeAttachment).toHaveBeenCalledWith(7, 'iccid_changed', null, expect.anything());
    expect(auditCalls()).toEqual([
      {
        table: 'sim_id',
        args: expect.objectContaining({
          entityId: 'sim_abc',
          action: 'detached',
          actor: 'ocpp',
          actorLabel: 'BootNotification',
          notes: 'iccid_changed',
        }),
      },
      {
        table: 'station_id',
        args: expect.objectContaining({
          entityId: 'sta_1',
          action: 'updated',
          notes: 'sim_detached',
          after: { simAttachment: null },
        }),
      },
    ]);
  });

  it('writes no audit row when the attachment was closed meanwhile', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment());
    mocks.getSim.mockResolvedValue(sim());
    mocks.closeAttachment.mockResolvedValue(null);
    expect(await closeStationAttachmentOnIccidChange('sta_1', OTHER_ICCID)).toBe(false);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('keeps the attachment when the reported ICCID is the attached SIM (final review I1)', async () => {
    mocks.openStationAttachment.mockResolvedValue(
      attachment({ source: 'imported', confirmedAt: new Date() }),
    );
    mocks.getSim.mockResolvedValue(sim());
    expect(await closeStationAttachmentOnIccidChange('sta_1', `${ICCID}F`)).toBe(false);
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('ensureSim', () => {
  it('creates the SIM with its fields in one transaction and audits created once', async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({
      sim: sim({ label: 'Gate', notes: 'n', imsi: '310150123456789' }),
      created: true,
    });
    const fields = { label: 'Gate', notes: 'n', imsi: '310150123456789' };
    const result = await service.ensureSim(ICCID, { actor: ACTOR, fields });
    expect(result.created).toBe(true);
    // The service transaction (depth 1) runs the insert; the audit is a savepoint in it.
    expect(mocks.findOrCreateSimRecord).toHaveBeenCalledWith(
      ICCID,
      'usr_1',
      expect.objectContaining({ depth: 1 }),
      fields,
    );
    expect(auditCalls()).toEqual([
      { table: 'sim_id', args: expect.objectContaining({ action: 'created' }) },
    ]);
    // The audit row never names the IMSI.
    expect(JSON.stringify(auditCalls()[0]?.args['after'])).not.toContain('310150123456789');
  });

  it('returns an existing SIM unchanged, with no audit row, for the loser of a race', async () => {
    const result = await service.ensureSim(ICCID, { actor: ACTOR, fields: { label: 'Other' } });
    expect(result).toEqual({ sim: sim(), created: false });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.updateSimFields).not.toHaveBeenCalled();
  });
});

describe('enterStationIccid', () => {
  const allSites = { actor: ACTOR, withAllSites: true, featureOn: true };
  const siteOnly = { actor: ACTOR, withAllSites: false, featureOn: true };

  it('writes no SIM row and no attachment while both switches are off', async () => {
    expect(await enterStationIccid('sta_1', ICCID, { ...allSites, featureOn: false })).toBe('off');
    expect(mocks.findOrCreateSimRecord).not.toHaveBeenCalled();
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
  });

  it('creates the SIM, attaches it entered and confirms it for an all-site user', async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({ sim: sim(), created: true });
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'entered', confirmedAt: new Date() }),
      created: true,
    });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached');
    expect(mocks.findOrCreateSimRecord).toHaveBeenCalledWith(ICCID, 'usr_1', expect.anything(), {});
    expect(mocks.attachSimToStation).toHaveBeenCalledWith(
      {
        simId: 'sim_abc',
        stationId: 'sta_1',
        source: 'entered',
        by: 'usr_1',
        withAllSites: true,
        confirm: true,
      },
      expect.anything(),
    );
    const actions = auditCalls().map((c) => `${c.table}:${String(c.args['action'])}`);
    expect(actions).toEqual(['sim_id:created', 'sim_id:attached', 'station_id:updated']);
    expect(auditCalls()[2]?.args['notes']).toBe('sim_attached (none)');
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain(ICCID);
  });

  it('leaves an entry by a site-restricted user unconfirmed', async () => {
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'entered' }),
      created: true,
    });
    expect(await enterStationIccid('sta_1', ICCID, siteOnly)).toBe('attached');
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toMatchObject({
      withAllSites: false,
      confirm: false,
    });
  });

  it('changes nothing when the station already holds the SIM, even unconfirmed', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment());
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('unchanged');
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("replaces the station's attachment of another SIM", async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment({ id: 3, simId: 'sim_old' }));
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ id: 8, source: 'entered' }),
      created: true,
    });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached');
    expect(mocks.closeAttachment).toHaveBeenCalledWith(3, 'replaced', 'usr_1', expect.anything());
  });

  it('displaces an unconfirmed reported attachment elsewhere for an all-site user', async () => {
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2' }));
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ id: 9, source: 'entered' }),
      created: true,
    });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached');
    expect(mocks.closeAttachment).toHaveBeenCalledWith(4, 'displaced', 'usr_1', expect.anything());
    const detached = auditCalls().filter((c) => c.args['action'] === 'detached');
    expect(detached.map((c) => c.args['notes'])).toEqual(['displaced']);
  });

  it('never displaces for a site-restricted user', async () => {
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2' }));
    expect(await enterStationIccid('sta_1', ICCID, siteOnly)).toBe('attached_elsewhere');
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });

  it.each([
    ['a confirmed reported', { confirmedAt: new Date() }],
    ['an entered', { source: 'entered' }],
    ['an attached', { source: 'attached', confirmedAt: new Date() }],
    ['an imported', { source: 'imported', confirmedAt: new Date() }],
  ])('never displaces %s attachment and still replaces the station attachment', async (_, f) => {
    mocks.openStationAttachment.mockResolvedValue(attachment({ id: 3, simId: 'sim_old' }));
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2', ...f }));
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached_elsewhere');
    expect(mocks.closeAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.closeAttachment).toHaveBeenCalledWith(3, 'replaced', 'usr_1', expect.anything());
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });

  it.each([
    ['an unconfirmed entered', { source: 'entered' }],
    ['an unconfirmed attached', { source: 'attached' }],
    ['an unconfirmed imported', { source: 'imported' }],
  ])('an all-site entry leaves %s attachment elsewhere in place', async (_, f) => {
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2', ...f }));
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached_elsewhere');
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });

  it('answers attach_conflict, not attached_elsewhere, when every attempt lost a race', async () => {
    mocks.attachSimToStation.mockResolvedValue({ kind: 'station_has_sim' });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attach_conflict');
    expect(mocks.attachSimToStation).toHaveBeenCalledTimes(3);
  });

  it('writes each audit row in a savepoint and keeps the attachment when one fails', async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({ sim: sim(), created: true });
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'entered' }),
      created: true,
    });
    // writeAudit catches a failed insert and reports it through the logger only.
    mocks.writeAudit.mockImplementation(
      (_config: unknown, _args: unknown, _db: unknown, logger: { warn: (o: unknown) => void }) => {
        logger.warn({ code: '25P02' });
        return Promise.resolve();
      },
    );
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    expect(await enterStationIccid('sta_1', ICCID, { ...allSites, log }, dbExecutor as never)).toBe(
      'attached',
    );
    // The PATCH transaction (depth 0), the service transaction (1), one savepoint (2) per row;
    // the `created` row is in the SIM creation's own savepoint (2), so its audit savepoint is 3.
    const writers = mocks.writeAudit.mock.calls.map((call) => (call[2] as { depth: number }).depth);
    expect(writers).toEqual([3, 2, 2]);
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: { code: '25P02' } }),
      'SIM audit row not written; the change is kept',
    );
  });

  it('answers attached_elsewhere when the displaced attachment was confirmed meanwhile', async () => {
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2' }));
    mocks.closeAttachment.mockResolvedValue(null);
    mocks.attachSimToStation.mockResolvedValue({ kind: 'sim_attached_elsewhere' });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached_elsewhere');
    expect(auditCalls().filter((c) => c.args['action'] === 'detached')).toEqual([]);
  });

  it('makes no attachment for an inactive SIM', async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({
      sim: sim({ status: 'inactive' }),
      created: false,
    });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('sim_inactive');
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
  });

  it("closes the station's attachment of another SIM as replaced for an inactive SIM", async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({
      sim: sim({ status: 'inactive' }),
      created: false,
    });
    mocks.openStationAttachment.mockResolvedValue(attachment({ id: 3, simId: 'sim_old' }));
    expect(await enterStationIccid('sta_1', ICCID, siteOnly)).toBe('sim_inactive');
    expect(mocks.closeAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.closeAttachment).toHaveBeenCalledWith(3, 'replaced', 'usr_1', expect.anything());
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
    const detached = auditCalls().filter((c) => c.args['action'] === 'detached');
    expect(detached.map((c) => c.args['notes'])).toEqual(['replaced']);
  });

  it('maps a SIM deactivated during the attach to sim_inactive', async () => {
    mocks.attachSimToStation.mockResolvedValue({ kind: 'sim_inactive' });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('sim_inactive');
  });

  it('treats an attachment already open at the station as unchanged, with no audit row', async () => {
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment(),
      created: false,
    });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('unchanged');
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("closes the station's attachment detached for a removed ICCID", async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment());
    expect(await enterStationIccid('sta_1', null, allSites)).toBe('none');
    expect(mocks.closeAttachment).toHaveBeenCalledWith(7, 'detached', 'usr_1', expect.anything());
    expect(mocks.findOrCreateSimRecord).not.toHaveBeenCalled();
  });

  // An all-site entry vouches only for the attachment it made: one that attached
  // nothing must not confirm the SIM at a later Refresh, when the SIM may have
  // moved on (security review M1).
  it.each([
    [
      'attached_elsewhere',
      () => {
        mocks.openSimAttachment.mockResolvedValue(
          attachment({ id: 4, stationId: 'sta_2', confirmedAt: new Date() }),
        );
      },
    ],
    [
      'sim_inactive',
      () => {
        mocks.findOrCreateSimRecord.mockResolvedValue({
          sim: sim({ status: 'inactive' }),
          created: false,
        });
      },
    ],
    [
      'attach_conflict',
      () => {
        mocks.attachSimToStation.mockResolvedValue({ kind: 'station_has_sim' });
      },
    ],
  ])('clears the all-site vouch of an entry that attached nothing (%s)', async (result, setup) => {
    setup();
    mocks.openStationAttachment.mockResolvedValue(attachment({ id: 3, simId: 'sim_old' }));
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe(result);
    expect(mocks.stationUpdates).toEqual([{ iccidEnteredWithAllSites: false }]);
  });

  it('keeps the vouch of an entry that attached its SIM, also after replacing another (final review I2)', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment({ id: 3, simId: 'sim_old' }));
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ id: 8, source: 'entered', confirmedAt: new Date() }),
      created: true,
    });
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('attached');
    expect(mocks.closeAttachment).toHaveBeenCalledWith(3, 'replaced', 'usr_1', expect.anything());
    expect(mocks.stationUpdates).toEqual([]);
  });

  it('keeps the vouch for an unchanged entry and while the switches are off', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment());
    expect(await enterStationIccid('sta_1', ICCID, allSites)).toBe('unchanged');
    expect(await enterStationIccid('sta_1', ICCID, { ...allSites, featureOn: false })).toBe('off');
    expect(mocks.stationUpdates).toEqual([]);
  });
});

describe('attachReportedStationSim', () => {
  it('returns the open attachment without a write', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment());
    mocks.getSim.mockResolvedValue(sim());
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toMatchObject({
      kind: 'attached',
      sim: { id: 'sim_abc' },
      attachment: { id: 7 },
    });
    expect(mocks.findOrCreateSimRecord).not.toHaveBeenCalled();
  });

  it('answers no_iccid for a station without a valid ICCID, writing nothing', async () => {
    mocks.stationIccid.value = 'junk';
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toEqual({ kind: 'no_iccid' });
    expect(mocks.findOrCreateSimRecord).not.toHaveBeenCalled();
  });

  it('creates the SIM and an unconfirmed reported attachment with no attaching user', async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({ sim: sim(), created: true });
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment(),
      created: true,
    });
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toMatchObject({
      kind: 'attached',
    });
    expect(mocks.findOrCreateSimRecord).toHaveBeenCalledWith(ICCID, null, expect.anything(), {});
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toEqual({
      simId: 'sim_abc',
      stationId: 'sta_1',
      source: 'reported',
      by: null,
      withAllSites: false,
      confirm: false,
    });
  });

  it.each([
    ['unconfirmed reported', {}],
    ['confirmed', { confirmedAt: new Date() }],
    ['entered', { source: 'entered' }],
  ])('never displaces a %s attachment elsewhere', async (_, f) => {
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2', ...f }));
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toEqual({
      kind: 'attached_elsewhere',
    });
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });

  it('attaches an ICCID a site-restricted user entered as entered, unconfirmed', async () => {
    mocks.stationIccid.source = 'entered';
    mocks.stationIccid.enteredBy = 'usr_9';
    mocks.findOrCreateSimRecord.mockResolvedValue({ sim: sim(), created: true });
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'entered', attachedBy: 'usr_9' }),
      created: true,
    });
    await attachReportedStationSim('sta_1', ACTOR.audit);
    expect(mocks.findOrCreateSimRecord).toHaveBeenCalledWith(ICCID, 'usr_9', expect.anything(), {});
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toEqual({
      simId: 'sim_abc',
      stationId: 'sta_1',
      source: 'entered',
      by: 'usr_9',
      withAllSites: false,
      confirm: false,
    });
  });

  it('confirms an entered ICCID only when an all-site user entered it', async () => {
    mocks.stationIccid.source = 'entered';
    mocks.stationIccid.enteredBy = 'usr_9';
    mocks.stationIccid.enteredWithAllSites = true;
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'entered' }),
      created: true,
    });
    await attachReportedStationSim('sta_1', ACTOR.audit);
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toMatchObject({
      source: 'entered',
      by: 'usr_9',
      withAllSites: true,
      confirm: true,
    });

    // The entering user was deleted: a confirmation names a person, so none.
    vi.clearAllMocks();
    mocks.stationIccid.enteredBy = null;
    await attachReportedStationSim('sta_1', ACTOR.audit);
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toMatchObject({
      source: 'entered',
      by: null,
      withAllSites: false,
      confirm: false,
    });
  });

  it.each([
    ['has lost access to every site', { hasAllSiteAccess: false, isActive: true }],
    ['was deactivated', { hasAllSiteAccess: true, isActive: false }],
  ])('attaches unconfirmed when the all-site person who entered it %s', async (_, now) => {
    mocks.stationIccid.source = 'entered';
    mocks.stationIccid.enteredBy = 'usr_9';
    mocks.stationIccid.enteredWithAllSites = true;
    Object.assign(mocks.enteringUser, now);
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'entered' }),
      created: true,
    });
    await attachReportedStationSim('sta_1', ACTOR.audit);
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toMatchObject({
      source: 'entered',
      by: 'usr_9',
      withAllSites: false,
      confirm: false,
    });
  });

  it('never displaces at Refresh, also for an ICCID an all-site user entered', async () => {
    mocks.stationIccid.source = 'entered';
    mocks.stationIccid.enteredBy = 'usr_9';
    mocks.stationIccid.enteredWithAllSites = true;
    mocks.openSimAttachment.mockResolvedValue(attachment({ id: 4, stationId: 'sta_2' }));
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toEqual({
      kind: 'attached_elsewhere',
    });
    expect(mocks.closeAttachment).not.toHaveBeenCalled();
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });

  it('answers attach_conflict when every attempt lost a race', async () => {
    mocks.attachSimToStation.mockResolvedValue({ kind: 'station_has_sim' });
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toEqual({
      kind: 'attach_conflict',
    });
  });

  it('answers sim_inactive for an inactive SIM', async () => {
    mocks.findOrCreateSimRecord.mockResolvedValue({
      sim: sim({ status: 'inactive' }),
      created: false,
    });
    expect(await attachReportedStationSim('sta_1', ACTOR.audit)).toEqual({ kind: 'sim_inactive' });
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });
});

describe('attachSim (SIM page, import)', () => {
  it('attaches confirmed and audits the SIM and the station', async () => {
    mocks.getSim.mockResolvedValue(sim({ provider: 'hologram' }));
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'attached', confirmedAt: new Date() }),
      created: true,
    });
    expect(await attachSim('sim_abc', 'sta_1', { actor: ACTOR })).toMatchObject({
      kind: 'attached',
    });
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toMatchObject({
      source: 'attached',
      by: 'usr_1',
      withAllSites: true,
      confirm: true,
    });
    expect(auditCalls().map((c) => c.args['notes'])).toEqual([null, 'sim_attached (hologram)']);
  });

  it('passes imported and the import note', async () => {
    mocks.getSim.mockResolvedValue(sim());
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment({ source: 'imported' }),
      created: true,
    });
    await attachSim('sim_abc', 'sta_1', { actor: ACTOR, source: 'imported', notes: 'CSV import' });
    expect(mocks.attachSimToStation.mock.calls[0]?.[0]).toMatchObject({ source: 'imported' });
    expect(auditCalls()[0]?.args['notes']).toBe('CSV import');
  });

  it.each([
    [{ kind: 'sim_attached_elsewhere' }, 'sim_attached_elsewhere'],
    [{ kind: 'station_has_sim' }, 'station_has_sim'],
    [{ kind: 'sim_inactive' }, 'sim_inactive'],
    [{ kind: 'sim_not_found' }, 'sim_not_found'],
  ])('maps %j without an audit row', async (result, kind) => {
    mocks.getSim.mockResolvedValue(sim());
    mocks.attachSimToStation.mockResolvedValue(result);
    expect(await attachSim('sim_abc', 'sta_1', { actor: ACTOR })).toEqual({ kind });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('answers unchanged for a SIM already open at the station, with no audit row', async () => {
    mocks.getSim.mockResolvedValue(sim());
    mocks.attachSimToStation.mockResolvedValue({
      kind: 'attached',
      attachment: attachment(),
      created: false,
    });
    expect(await attachSim('sim_abc', 'sta_1', { actor: ACTOR })).toMatchObject({
      kind: 'unchanged',
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('confirmStationAttachment', () => {
  it('audits only a confirmation that happened, from the row the writer confirmed', async () => {
    // A read after the commit could miss the row (closed meanwhile): the audit
    // uses the confirmed row the writer returned, never a second read.
    mocks.openStationAttachment.mockResolvedValue(null);
    mocks.confirmAttachment.mockResolvedValue({
      result: 'confirmed',
      attachment: attachment({ confirmedAt: new Date() }),
    });
    expect(await confirmStationAttachment('sta_1', 7, { actor: ACTOR })).toBe('confirmed');
    expect(mocks.confirmAttachment).toHaveBeenCalledWith('sta_1', 7, 'usr_1', expect.anything());
    expect(auditCalls().map((c) => `${c.table}:${String(c.args['action'])}`)).toEqual([
      'sim_id:attachment_confirmed',
      'station_id:updated',
    ]);
    expect(auditCalls()[1]?.args['notes']).toBe('sim_attachment_confirmed');
    expect(auditCalls()[0]?.args['after']).toMatchObject({
      attachment: { attachmentId: 7, confirmed: true },
    });
    expect(mocks.openStationAttachment).not.toHaveBeenCalled();

    vi.clearAllMocks();
    for (const result of [
      'already_confirmed',
      'attachment_changed',
      'not_attached',
      'sim_inactive',
    ]) {
      mocks.confirmAttachment.mockResolvedValue({ result });
      expect(await confirmStationAttachment('sta_1', 7, { actor: ACTOR })).toBe(result);
    }
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('detachStationSim', () => {
  it('closes the open attachment detached and audits it', async () => {
    mocks.openStationAttachment.mockResolvedValue(attachment());
    expect(await detachStationSim('sta_1', { actor: ACTOR })).toMatchObject({ id: 7 });
    // The all-site vouch of an entered ICCID ends with the attachment.
    expect(mocks.stationUpdates).toEqual([{ iccidEnteredWithAllSites: false }]);
    expect(mocks.closeAttachment).toHaveBeenCalledWith(7, 'detached', 'usr_1', expect.anything());
    // The close and the vouch clear run in one transaction (final review I3).
    const closeExecutor = mocks.closeAttachment.mock.calls[0]?.[3] as { depth: number };
    expect(closeExecutor.depth).toBe(1);
    expect(mocks.stationUpdateDepths).toEqual([1]);
    expect(auditCalls().map((c) => c.args['notes'])).toEqual(['detached', 'sim_detached']);
  });

  it('answers null without an open attachment', async () => {
    expect(await detachStationSim('sta_1', { actor: ACTOR })).toBeNull();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('deactivateSim and reactivateSim', () => {
  it('audits deactivated and the attachment it closed, with no provider call', async () => {
    const closed = attachment({ detachedAt: new Date(), detachReason: 'deactivated' });
    mocks.setSimStatus.mockResolvedValue({
      kind: 'changed',
      before: sim(),
      after: sim({ status: 'inactive' }),
      closedAttachment: closed,
    });
    expect(await deactivateSim('sim_abc', { actor: ACTOR })).toMatchObject({ kind: 'changed' });
    expect(mocks.setSimStatus).toHaveBeenCalledWith(
      'sim_abc',
      'inactive',
      'usr_1',
      expect.anything(),
    );
    expect(auditCalls().map((c) => `${c.table}:${String(c.args['action'])}`)).toEqual([
      'sim_id:deactivated',
      'sim_id:detached',
      'station_id:updated',
    ]);
    expect(auditCalls()[1]?.args['notes']).toBe('deactivated');
    expect(mocks.stationUpdates).toEqual([{ iccidEnteredWithAllSites: false }]);
  });

  it('reactivates without opening an attachment', async () => {
    mocks.setSimStatus.mockResolvedValue({
      kind: 'changed',
      before: sim({ status: 'inactive' }),
      after: sim(),
      closedAttachment: null,
    });
    await reactivateSim('sim_abc', { actor: ACTOR });
    expect(mocks.setSimStatus).toHaveBeenCalledWith(
      'sim_abc',
      'active',
      'usr_1',
      expect.anything(),
    );
    expect(auditCalls().map((c) => c.args['action'])).toEqual(['reactivated']);
    expect(mocks.attachSimToStation).not.toHaveBeenCalled();
  });

  it('writes no audit row for the same status again', async () => {
    mocks.setSimStatus.mockResolvedValue({ kind: 'unchanged', sim: sim() });
    expect(await reactivateSim('sim_abc', { actor: ACTOR })).toMatchObject({ kind: 'unchanged' });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('updateSim and deleteSim', () => {
  it('audits a change of the operator fields without the ICCID', async () => {
    mocks.updateSimFields.mockResolvedValue({ before: sim(), after: sim({ label: 'Roof' }) });
    await updateSim('sim_abc', { label: 'Roof' }, { actor: ACTOR });
    expect(auditCalls().map((c) => c.args['action'])).toEqual(['updated']);
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain(ICCID);
  });

  it('never stores the IMSI, only whether it changed', async () => {
    const IMSI_BEFORE = '310260000004001';
    const IMSI_AFTER = '310260000004002';
    mocks.updateSimFields.mockResolvedValue({
      before: sim({ imsi: IMSI_BEFORE }),
      after: sim({ imsi: IMSI_AFTER }),
    });
    await updateSim('sim_abc', { imsi: IMSI_AFTER }, { actor: ACTOR });
    const [row] = auditCalls();
    expect(row?.args['after']).toMatchObject({ imsiChanged: true });
    expect(row?.args['before']).not.toHaveProperty('imsi');
    expect(row?.args['after']).not.toHaveProperty('imsi');

    vi.clearAllMocks();
    mocks.updateSimFields.mockResolvedValue({
      before: sim({ imsi: IMSI_BEFORE }),
      after: sim({ imsi: IMSI_BEFORE, label: 'Roof' }),
    });
    await updateSim('sim_abc', { label: 'Roof' }, { actor: ACTOR });
    expect(auditCalls()[0]?.args['after']).toMatchObject({ imsiChanged: false });

    vi.clearAllMocks();
    mocks.deleteSim.mockResolvedValue({ kind: 'deleted', sim: sim({ imsi: IMSI_BEFORE }) });
    await deleteSim('sim_abc', { actor: ACTOR });
    mocks.findOrCreateSimRecord.mockResolvedValue({
      sim: sim({ imsi: IMSI_BEFORE }),
      created: true,
    });
    mocks.attachSimToStation.mockResolvedValue({ kind: 'sim_inactive' });
    await enterStationIccid('sta_1', ICCID, { actor: ACTOR, withAllSites: true, featureOn: true });
    expect(auditCalls().map((c) => c.args['action'])).toEqual(['deleted', 'created']);
    for (const imsi of [IMSI_BEFORE, IMSI_AFTER]) {
      expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain(imsi);
    }
  });

  it('writes no audit row when nothing changed', async () => {
    mocks.updateSimFields.mockResolvedValue({ before: sim(), after: sim() });
    await updateSim('sim_abc', { label: null }, { actor: ACTOR });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('audits a delete only when it happened', async () => {
    mocks.deleteSim.mockResolvedValue({ kind: 'deleted', sim: sim({ label: 'Roof' }) });
    expect(await deleteSim('sim_abc', { actor: ACTOR })).toMatchObject({ kind: 'deleted' });
    expect(auditCalls()).toEqual([
      {
        table: 'sim_id',
        args: expect.objectContaining({ action: 'deleted', after: null }),
      },
    ]);
    vi.clearAllMocks();
    mocks.deleteSim.mockResolvedValue({ kind: 'attached' });
    expect(await deleteSim('sim_abc', { actor: ACTOR })).toEqual({ kind: 'attached' });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('data plan push after a SIM change', () => {
  it('wraps a station confirm and detach in the data plan push', async () => {
    mocks.confirmAttachment.mockResolvedValue({
      result: 'confirmed',
      attachment: attachment({ confirmedAt: new Date() }),
    });
    await confirmStationAttachment('sta_1', 7, { actor: ACTOR });
    mocks.openStationAttachment.mockResolvedValue(attachment());
    await detachStationSim('sta_1', { actor: ACTOR });
    expect(mocks.planPushes).toEqual([['sta_1'], ['sta_1']]);
  });

  it('includes the station a displaced attachment leaves for an entered ICCID', async () => {
    mocks.getSimByIccid.mockResolvedValue(sim());
    mocks.openSimAttachment.mockResolvedValue(attachment({ stationId: 'sta_other' }));
    await enterStationIccid('sta_1', ICCID, {
      actor: ACTOR,
      withAllSites: true,
      featureOn: true,
    }).catch(() => undefined);
    expect(mocks.planPushes[0]).toEqual(['sta_1', 'sta_other']);
  });

  it('pushes nothing inside the caller transaction (the caller pushes after its commit)', async () => {
    await dbExecutor.transaction(async (tx) => {
      await enterStationIccid(
        'sta_1',
        ICCID,
        { actor: ACTOR, withAllSites: false, featureOn: true },
        tx as never,
      ).catch(() => undefined);
    });
    expect(mocks.planPushes).toEqual([]);
  });

  it('wraps a SIM deactivation with the station holding the SIM', async () => {
    mocks.openSimAttachment.mockResolvedValue(attachment({ stationId: 'sta_9' }));
    mocks.setSimStatus.mockResolvedValue({ kind: 'unchanged' });
    await deactivateSim('sim_abc', { actor: ACTOR });
    expect(mocks.planPushes).toEqual([['sta_9']]);
  });
});
