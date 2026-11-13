// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal registry service: every writer result that changed a
// terminal writes one audit row, stamped with the write-time site
// (`auditSiteId`) and every site it names (`auditSiteIds`, security cases
// 268 and 277); a site change that closed the SIM attachment is audited at
// the old site (case 276).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  audits: [] as Record<string, unknown>[],
  createTerminal: vi.fn(),
  updateTerminal: vi.fn(),
  pairTerminal: vi.fn(),
  unpairTerminal: vi.fn(),
  setTerminalStatus: vi.fn(),
  deleteTerminal: vi.fn(),
  getTerminal: vi.fn(),
  recordTerminalDeviceStatus: vi.fn(),
  enterTerminalIccid: vi.fn(),
  detachTerminalSim: vi.fn(),
  auditTerminalSimClosed: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {},
  paymentTerminalAuditLog: {},
  createTerminal: h.createTerminal,
  updateTerminal: h.updateTerminal,
  pairTerminal: h.pairTerminal,
  unpairTerminal: h.unpairTerminal,
  setTerminalStatus: h.setTerminalStatus,
  deleteTerminal: h.deleteTerminal,
  getTerminal: h.getTerminal,
  recordTerminalDeviceStatus: h.recordTerminalDeviceStatus,
  writeAudit: (_cfg: unknown, args: Record<string, unknown>) => {
    h.audits.push(args);
    return Promise.resolve();
  },
}));

vi.mock('../sim-inventory.service.js', () => ({
  enterTerminalIccid: h.enterTerminalIccid,
  detachTerminalSim: h.detachTerminalSim,
  auditTerminalSimClosed: h.auditTerminalSimClosed,
}));

const svc = await import('../payment-terminal.service.js');

type Terminal = Parameters<typeof svc.terminalAuditView>[0];

function terminal(over: Record<string, unknown> = {}): Terminal {
  return {
    id: 'ptm_1',
    label: 'Front reader',
    provider: 'simulated',
    integrationMode: 'cloud',
    model: 'VP6825',
    serialNumber: '6825SIM000001',
    siteId: 'sit_a',
    stationId: 'sta_1',
    evseId: null,
    status: 'active',
    providerDeviceId: 'sim_term_1',
    ...over,
  } as unknown as Terminal;
}

const warn = vi.fn();
const ctx = {
  actor: { audit: { actor: 'operator' as const, actorUserId: 'usr_1' }, userId: 'usr_1' },
  log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audits.length = 0;
  h.getTerminal.mockResolvedValue(terminal());
});

describe('terminalAuditView and terminalAuditSiteIds', () => {
  it('keeps only the pairing and the states', () => {
    expect(svc.terminalAuditView(terminal())).toEqual({
      label: 'Front reader',
      provider: 'simulated',
      integrationMode: 'cloud',
      model: 'VP6825',
      serialNumber: '6825SIM000001',
      siteId: 'sit_a',
      stationId: 'sta_1',
      evseId: null,
      status: 'active',
    });
  });

  it('lists the write-time site and each view site once, without nulls', () => {
    expect(svc.terminalAuditSiteIds('sit_a', { siteId: 'sit_b' }, { siteId: 'sit_a' })).toEqual([
      'sit_a',
      'sit_b',
    ]);
    expect(svc.terminalAuditSiteIds(null, null, { siteId: 7 })).toEqual([]);
    expect(svc.terminalAuditSiteIds(null, 'text', { siteId: 'sit_c' })).toEqual(['sit_c']);
  });
});

describe('createPaymentTerminal', () => {
  it('passes the actor as creator and audits the new view', async () => {
    h.createTerminal.mockResolvedValue({ kind: 'created', terminal: terminal() });
    const out = await svc.createPaymentTerminal({ label: 'x' } as never, ctx);
    expect(out.kind).toBe('created');
    expect(h.createTerminal).toHaveBeenCalledWith({ label: 'x', createdBy: 'usr_1' });
    expect(h.audits).toEqual([
      expect.objectContaining({
        entityId: 'ptm_1',
        entityIdSnapshot: 'ptm_1',
        action: 'created',
        actor: 'operator',
        actorUserId: 'usr_1',
        before: null,
        notes: null,
        after: expect.objectContaining({
          label: 'Front reader',
          auditSiteId: 'sit_a',
          auditSiteIds: ['sit_a'],
        }),
      }),
    ]);
  });

  it('audits nothing when the writer refused', async () => {
    h.createTerminal.mockResolvedValue({ kind: 'device_in_use' });
    await svc.createPaymentTerminal({} as never, ctx);
    expect(h.audits).toHaveLength(0);
  });

  it('stamps a null site and warns when the site read fails', async () => {
    h.createTerminal.mockResolvedValue({ kind: 'created', terminal: terminal({ siteId: null }) });
    h.getTerminal.mockRejectedValue(new Error('db down'));
    await svc.createPaymentTerminal({} as never, ctx);
    expect(h.audits[0]!['after']).toMatchObject({ auditSiteId: null, auditSiteIds: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentTerminalId: 'ptm_1' }),
      'Terminal audit site not read',
    );
  });

  it('stamps a null site when the terminal is gone and no logger is given', async () => {
    h.createTerminal.mockResolvedValue({ kind: 'created', terminal: terminal() });
    h.getTerminal.mockResolvedValue(null);
    await svc.createPaymentTerminal({} as never, { actor: ctx.actor });
    expect(h.audits[0]!['after']).toMatchObject({ auditSiteId: null, auditSiteIds: ['sit_a'] });
  });
});

describe('updatePaymentTerminal', () => {
  it('audits a real change and the closed SIM at the old site', async () => {
    const open = { id: 'sat_1' };
    const closed = { id: 'sat_1' };
    h.updateTerminal.mockResolvedValue({
      kind: 'updated',
      before: terminal({ siteId: 'sit_b' }),
      after: terminal({ siteId: 'sit_a' }),
      simClosed: { open, closed },
    });
    await svc.updatePaymentTerminal('ptm_1', { siteId: 'sit_a' }, ctx);
    expect(h.audits.map((a) => a['action'])).toEqual(['updated', 'sim_detached']);
    expect(h.audits[0]!['before']).toMatchObject({
      siteId: 'sit_b',
      auditSiteId: 'sit_a',
      auditSiteIds: ['sit_a', 'sit_b'],
    });
    expect(h.audits[1]).toMatchObject({
      notes: 'site_changed',
      after: null,
      before: { attachmentId: 'sat_1', auditSiteId: 'sit_b', auditSiteIds: ['sit_b'] },
    });
    expect(h.auditTerminalSimClosed).toHaveBeenCalledWith(open, closed, ctx);
  });

  it('writes no row when nothing visible changed and no SIM closed', async () => {
    h.updateTerminal.mockResolvedValue({
      kind: 'updated',
      before: terminal(),
      after: terminal(),
      simClosed: null,
    });
    await svc.updatePaymentTerminal('ptm_1', {}, ctx);
    expect(h.audits).toHaveLength(0);
    expect(h.auditTerminalSimClosed).not.toHaveBeenCalled();
  });

  it('audits nothing for a missing terminal', async () => {
    h.updateTerminal.mockResolvedValue({ kind: 'not_found' });
    expect((await svc.updatePaymentTerminal('ptm_x', {}, ctx)).kind).toBe('not_found');
    expect(h.audits).toHaveLength(0);
  });
});

describe('pairing, status and delete', () => {
  it('audits a pairing and its SIM close', async () => {
    h.pairTerminal.mockResolvedValue({
      kind: 'paired',
      before: terminal({ stationId: null }),
      after: terminal(),
      simClosed: { open: { id: 'o' }, closed: { id: 'c' } },
    });
    await svc.pairPaymentTerminal('ptm_1', { stationId: 'sta_1', evseId: null }, ctx);
    expect(h.audits.map((a) => a['action'])).toEqual(['paired', 'sim_detached']);
  });

  it('audits nothing for a refused pairing', async () => {
    h.pairTerminal.mockResolvedValue({ kind: 'evse_taken' });
    await svc.pairPaymentTerminal('ptm_1', {} as never, ctx);
    expect(h.audits).toHaveLength(0);
  });

  it('audits an unpairing only when it happened', async () => {
    h.unpairTerminal.mockResolvedValueOnce({
      kind: 'unpaired',
      before: terminal(),
      after: terminal({ stationId: null }),
    });
    await svc.unpairPaymentTerminal('ptm_1', ctx);
    h.unpairTerminal.mockResolvedValueOnce({ kind: 'not_paired' });
    await svc.unpairPaymentTerminal('ptm_1', ctx);
    expect(h.audits.map((a) => a['action'])).toEqual(['unpaired']);
  });

  it('audits deactivated and reactivated by the new status', async () => {
    h.setTerminalStatus.mockResolvedValue({
      kind: 'changed',
      before: terminal(),
      after: terminal({ status: 'inactive' }),
    });
    await svc.setPaymentTerminalStatus('ptm_1', 'inactive', ctx);
    await svc.setPaymentTerminalStatus('ptm_1', 'active', ctx);
    h.setTerminalStatus.mockResolvedValue({ kind: 'unchanged' });
    await svc.setPaymentTerminalStatus('ptm_1', 'active', ctx);
    expect(h.audits.map((a) => a['action'])).toEqual(['deactivated', 'reactivated']);
  });

  it('audits a delete with no entity link at the terminal site, without reading it', async () => {
    h.deleteTerminal.mockResolvedValue({
      kind: 'deleted',
      terminal: terminal({ siteId: 'sit_d' }),
    });
    await svc.deletePaymentTerminal('ptm_1', ctx);
    expect(h.getTerminal).not.toHaveBeenCalled();
    expect(h.audits[0]).toMatchObject({
      entityId: null,
      entityIdSnapshot: 'ptm_1',
      action: 'deleted',
      after: null,
      before: expect.objectContaining({ auditSiteId: 'sit_d' }),
    });
    h.deleteTerminal.mockResolvedValue({ kind: 'has_transactions' });
    await svc.deletePaymentTerminal('ptm_1', ctx);
    expect(h.audits).toHaveLength(1);
  });
});

describe('syncPaymentTerminalDevice', () => {
  const now = new Date('2026-11-12T10:00:00Z');

  it('returns null for an unknown terminal', async () => {
    h.recordTerminalDeviceStatus.mockResolvedValue(null);
    expect(
      await svc.syncPaymentTerminalDevice('ptm_x', { online: true, lastSeenAt: null }, ctx, now),
    ).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it('audits an online change, passes the firmware and attaches a reported SIM', async () => {
    h.recordTerminalDeviceStatus.mockResolvedValue({
      onlineChanged: true,
      before: false,
      after: true,
    });
    h.enterTerminalIccid.mockResolvedValue({ kind: 'attached', attachment: { id: 'sat_9' } });
    const out = await svc.syncPaymentTerminalDevice(
      'ptm_1',
      { online: true, lastSeenAt: now, firmwareVersion: '1.01.106', iccid: '8901' },
      ctx,
      now,
    );
    expect(out).toEqual({ onlineChanged: true, online: true });
    expect(h.recordTerminalDeviceStatus).toHaveBeenCalledWith(
      'ptm_1',
      { online: true, lastSeenAt: now, firmwareVersion: '1.01.106' },
      now,
    );
    expect(h.enterTerminalIccid).toHaveBeenCalledWith(
      'ptm_1',
      '8901',
      expect.objectContaining({ source: 'reported', withAllSites: false }),
    );
    expect(h.audits.map((a) => [a['action'], a['before'], a['after']])).toEqual([
      [
        'status_synced',
        expect.objectContaining({ online: false }),
        expect.objectContaining({ online: true }),
      ],
      [
        'sim_attached',
        null,
        expect.objectContaining({ attachmentId: 'sat_9', source: 'reported' }),
      ],
    ]);
  });

  it('leaves the firmware out when not reported and audits no unchanged state', async () => {
    h.recordTerminalDeviceStatus.mockResolvedValue({
      onlineChanged: false,
      before: true,
      after: true,
    });
    h.enterTerminalIccid.mockResolvedValue({ kind: 'unchanged' });
    await svc.syncPaymentTerminalDevice(
      'ptm_1',
      { online: true, lastSeenAt: null, iccid: '8901' },
      ctx,
    );
    expect(h.recordTerminalDeviceStatus.mock.calls[0]![1]).toEqual({
      online: true,
      lastSeenAt: null,
    });
    expect(h.audits).toHaveLength(0);
  });

  it('keeps the status when the SIM attach fails (fail-open)', async () => {
    h.recordTerminalDeviceStatus.mockResolvedValue({
      onlineChanged: false,
      before: null,
      after: null,
    });
    h.enterTerminalIccid.mockRejectedValue(new Error('conflict'));
    const out = await svc.syncPaymentTerminalDevice(
      'ptm_1',
      { online: null, lastSeenAt: null, iccid: '8901' },
      ctx,
    );
    expect(out).toEqual({ onlineChanged: false, online: null });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentTerminalId: 'ptm_1' }),
      'Reported terminal SIM not attached',
    );
  });
});

describe('SIM attach and detach', () => {
  it('audits an entered SIM with whether it was confirmed', async () => {
    h.enterTerminalIccid.mockResolvedValue({
      kind: 'attached',
      attachment: { id: 'sat_1', confirmedAt: new Date() },
    });
    await svc.attachPaymentTerminalSim('ptm_1', '8901', true, ctx);
    expect(h.enterTerminalIccid).toHaveBeenCalledWith(
      'ptm_1',
      '8901',
      expect.objectContaining({ source: 'entered', withAllSites: true }),
    );
    expect(h.audits[0]!['after']).toMatchObject({
      attachmentId: 'sat_1',
      source: 'entered',
      confirmed: true,
    });
    h.enterTerminalIccid.mockResolvedValue({ kind: 'attached_elsewhere' });
    await svc.attachPaymentTerminalSim('ptm_1', '8901', false, ctx);
    expect(h.audits).toHaveLength(1);
  });

  it('audits a detach, and returns false when nothing was attached', async () => {
    h.detachTerminalSim.mockResolvedValueOnce({ id: 'sat_1' });
    expect(await svc.detachPaymentTerminalSim('ptm_1', ctx)).toBe(true);
    h.detachTerminalSim.mockResolvedValueOnce(null);
    expect(await svc.detachPaymentTerminalSim('ptm_1', ctx)).toBe(false);
    expect(h.audits.map((a) => a['action'])).toEqual(['sim_detached']);
  });
});

describe('auditPaymentTerminalAction', () => {
  it('writes the transaction fields at the transaction site, never card data', async () => {
    await svc.auditPaymentTerminalAction(
      'ptm_1',
      'payment_voided',
      {
        id: 'ptx_1',
        siteId: 'sit_old',
        state: 'voided',
        requestedCents: 5000,
        authorizedCents: 5000,
        currency: 'USD',
      },
      ctx,
    );
    expect(h.getTerminal).not.toHaveBeenCalled();
    expect(h.audits[0]).toMatchObject({
      action: 'payment_voided',
      before: null,
      after: {
        transactionId: 'ptx_1',
        state: 'voided',
        requestedCents: 5000,
        authorizedCents: 5000,
        currency: 'USD',
        auditSiteId: 'sit_old',
        auditSiteIds: ['sit_old'],
      },
    });
  });
});
