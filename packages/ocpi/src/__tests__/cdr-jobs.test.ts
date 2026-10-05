// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result.
let selectResults: unknown[][] = [];
let updates: Record<string, unknown>[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}
function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    set: vi.fn((v: Record<string, unknown>) => {
      updates.push(v);
      return chain;
    }),
    where: vi.fn(() => chain),
  };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const mocks = vi.hoisted(() => ({
  issueSessionCdr: vi.fn(),
  pushCdr: vi.fn(),
  pushLegacyEvseRemoval: vi.fn(),
  isRoamingEnabled: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    update: vi.fn(() => makeUpdateChain()),
  },
  chargingSessions: { id: {}, status: {}, endedAt: {} },
  ocpiCdrBackfill: { id: {}, completedAt: {} },
  ocpiCdrs: { ocpiCdrId: {}, isCredit: {}, chargingSessionId: {}, pushStatus: {}, createdAt: {} },
  ocpiPartnerEndpoints: { partnerId: {}, module: {}, interfaceRole: {} },
  ocpiPartners: { id: {}, status: {}, legacyEvseUidsRemovedAt: {} },
  ocpiRoamingSessions: { chargingSessionId: {} },
  isRoamingEnabled: mocks.isRoamingEnabled,
  pruneRemovedOcpiEvses: vi.fn(async () => undefined),
}));
vi.mock('../services/cdr.service.js', () => ({
  issueSessionCdr: mocks.issueSessionCdr,
  pushCdr: mocks.pushCdr,
}));
vi.mock('../services/push.service.js', () => ({
  pushLegacyEvseRemoval: mocks.pushLegacyEvseRemoval,
}));

const {
  runCdrJob,
  runCdrPushJob,
  runCdrBackfillStep,
  runCdrSweep,
  runLegacyEvseRemovalJob,
  scheduleSessionCdr,
  processOcpiCdrJob,
} = await import('../services/cdr-jobs.js');

const queue = { add: vi.fn(async () => undefined) };

beforeEach(() => {
  selectResults = [];
  updates = [];
  vi.clearAllMocks();
  mocks.isRoamingEnabled.mockResolvedValue(true);
});

describe('scheduleSessionCdr', () => {
  it('adds one delayed job per session (jobId from the session id)', async () => {
    await scheduleSessionCdr(queue as never, 'ses_1');
    expect(queue.add).toHaveBeenCalledWith(
      'cdr',
      { sessionId: 'ses_1' },
      expect.objectContaining({ jobId: 'cdr-ses_1', delay: 60_000, attempts: 8 }),
    );
  });
});

describe('runCdrJob', () => {
  it('issues the CDR and pushes it', async () => {
    mocks.issueSessionCdr.mockResolvedValue({ status: 'created', cdrId: 'cdr-1' });
    mocks.pushCdr.mockResolvedValue('sent');
    await runCdrJob('ses_1');
    expect(mocks.pushCdr).toHaveBeenCalledWith('cdr-1');
  });

  it('pushes a CDR stored by an earlier run again', async () => {
    mocks.issueSessionCdr.mockResolvedValue({ status: 'existing', cdrId: 'cdr-1' });
    mocks.pushCdr.mockResolvedValue('already_sent');
    await runCdrJob('ses_1');
    expect(mocks.pushCdr).toHaveBeenCalledWith('cdr-1');
  });

  it('throws when the push fails, so BullMQ retries', async () => {
    mocks.issueSessionCdr.mockResolvedValue({ status: 'created', cdrId: 'cdr-1' });
    mocks.pushCdr.mockResolvedValue('failed');
    await expect(runCdrJob('ses_1')).rejects.toThrow('push failed');
  });

  it('does not throw for a partner without a CDRs receiver', async () => {
    mocks.issueSessionCdr.mockResolvedValue({ status: 'created', cdrId: 'cdr-1' });
    mocks.pushCdr.mockResolvedValue('no_receiver');
    await expect(runCdrJob('ses_1')).resolves.toBeUndefined();
  });

  it('pushes nothing when the session is not billable', async () => {
    mocks.issueSessionCdr.mockResolvedValue({ status: 'not_billable' });
    await runCdrJob('ses_1');
    expect(mocks.pushCdr).not.toHaveBeenCalled();
  });
});

describe('runCdrPushJob', () => {
  it('throws when the push fails, so BullMQ retries', async () => {
    mocks.pushCdr.mockResolvedValue('failed');
    await expect(runCdrPushJob('cdr-c1')).rejects.toThrow('push failed');
    mocks.pushCdr.mockResolvedValue('sent');
    await expect(runCdrPushJob('cdr-c1')).resolves.toBeUndefined();
  });
});

describe('runLegacyEvseRemovalJob', () => {
  it('marks the partner done after the removal was sent', async () => {
    mocks.pushLegacyEvseRemoval.mockResolvedValue(3);
    await runLegacyEvseRemovalJob('opr_1');
    expect(updates[0]).toEqual({ legacyEvseUidsRemovedAt: expect.any(Date) });
  });

  it('leaves the marker unset when the partner has no locations receiver', async () => {
    mocks.pushLegacyEvseRemoval.mockResolvedValue(null);
    await runLegacyEvseRemovalJob('opr_1');
    expect(updates).toHaveLength(0);
  });

  it('propagates a transport failure for a retry', async () => {
    mocks.pushLegacyEvseRemoval.mockRejectedValue(new Error('timeout'));
    await expect(runLegacyEvseRemovalJob('opr_1')).rejects.toThrow('timeout');
    expect(updates).toHaveLength(0);
  });
});

const CUTOFF = new Date('2026-10-04T00:00:00Z');
const DONE_BACKFILL = { id: 1, cutoffAt: CUTOFF, completedAt: CUTOFF };

describe('runCdrBackfillStep', () => {
  const OPEN = {
    id: 1,
    cutoffAt: CUTOFF,
    cursorEndedAt: null,
    cursorSessionId: null,
    completedAt: null,
  };

  it('schedules the next batch with spaced jobs and advances the cursor', async () => {
    const endedAt = new Date('2026-09-20T10:00:00Z');
    selectResults = [
      [OPEN],
      [
        { sessionId: 'ses_1', endedAt: new Date('2026-09-20T09:00:00Z') },
        { sessionId: 'ses_2', endedAt },
      ],
    ];
    await runCdrBackfillStep(queue as never);
    expect(queue.add).toHaveBeenCalledWith(
      'cdr',
      { sessionId: 'ses_1' },
      expect.objectContaining({ jobId: 'cdr-ses_1', delay: 0 }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'cdr',
      { sessionId: 'ses_2' },
      expect.objectContaining({ jobId: 'cdr-ses_2', delay: 5_000 }),
    );
    expect(updates).toEqual([{ cursorEndedAt: endedAt, cursorSessionId: 'ses_2' }]);
  });

  it('marks the backfill completed when nothing is left', async () => {
    selectResults = [[OPEN], []];
    await runCdrBackfillStep(queue as never);
    expect(queue.add).not.toHaveBeenCalled();
    expect(updates).toEqual([{ completedAt: expect.any(Date) }]);
  });

  it('never runs again once completed', async () => {
    selectResults = [[DONE_BACKFILL]];
    await runCdrBackfillStep(queue as never);
    expect(queue.add).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('runCdrSweep', () => {
  it('schedules missing CDRs, unsent credit CDRs, and legacy removals', async () => {
    selectResults = [
      [DONE_BACKFILL],
      [{ sessionId: 'ses_1' }, { sessionId: 'ses_2' }],
      [{ ocpiCdrId: 'cdr-c1' }],
      [{ id: 'opr_1' }],
    ];
    await runCdrSweep(queue as never);
    expect(queue.add).toHaveBeenCalledWith(
      'cdr',
      { sessionId: 'ses_1' },
      expect.objectContaining({ jobId: 'cdr-ses_1', delay: 0 }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'cdr',
      { sessionId: 'ses_2' },
      expect.objectContaining({ jobId: 'cdr-ses_2' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'cdr-push',
      { cdrId: 'cdr-c1' },
      expect.objectContaining({ jobId: 'cdr-push-cdr-c1' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'legacy-evse-removal',
      { partnerId: 'opr_1' },
      expect.objectContaining({ jobId: 'legacy-evse-removal-opr_1' }),
    );
  });

  it('does nothing while roaming is off', async () => {
    mocks.isRoamingEnabled.mockResolvedValue(false);
    await runCdrSweep(queue as never);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('processOcpiCdrJob', () => {
  it('routes jobs by name', async () => {
    mocks.issueSessionCdr.mockResolvedValue({ status: 'not_roaming' });
    mocks.pushLegacyEvseRemoval.mockResolvedValue(null);
    await processOcpiCdrJob({ name: 'cdr', data: { sessionId: 'ses_1' } } as never, queue as never);
    await processOcpiCdrJob(
      { name: 'legacy-evse-removal', data: { partnerId: 'opr_1' } } as never,
      queue as never,
    );
    expect(mocks.issueSessionCdr).toHaveBeenCalledWith('ses_1');
    expect(mocks.pushLegacyEvseRemoval).toHaveBeenCalledWith('opr_1');
  });
});
