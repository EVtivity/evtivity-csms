// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The EVSE and connector retire writer: unknown targets answer 404, hardware
// in use or reserved answers 409, a repeat changes nothing, and a change audits,
// recomputes availability (fail-open), announces the station status and tells
// the station Inoperative or Operative (never Operative to a disabled station).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

const q = vi.hoisted(() => ({
  selects: [] as unknown[],
  returns: [] as unknown[],
  sets: [] as unknown[],
  writeAudit: vi.fn(),
  recompute: vi.fn(),
  publish: vi.fn(),
  sendAvailability: vi.fn(),
}));

function chain(): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'limit']) b[method] = () => b;
  b['then'] = (res: (v: unknown) => unknown) => Promise.resolve(q.selects.shift() ?? []).then(res);
  return b;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => chain(),
      update: () => ({
        set: (s: unknown) => {
          q.sets.push(s);
          return {
            where: () => ({ returning: () => Promise.resolve(q.returns.shift() ?? []) }),
          };
        },
      }),
    },
    client: { tag: 'client' },
    writeAudit: q.writeAudit,
    recomputeStationAvailability: q.recompute,
  };
});
vi.mock('@evtivity/services/availability-command', () => ({
  sendAvailabilityCommand: q.sendAvailability,
}));
vi.mock('../lib/station-status-events.js', () => ({
  publishStationStatusChanged: q.publish,
}));

import {
  restoreConnector,
  restoreEvse,
  retireConnector,
  retireEvse,
} from '../services/station-evse-retire.service.js';

const log = pino({ level: 'silent' });
const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log,
};
const RETIRED = new Date('2026-11-01T00:00:00.000Z');

function evseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stationOcppId: 'CS-1',
    siteId: 'sit_1',
    disabledReason: null,
    evseDbId: 'evs_1',
    evseRetiredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  q.selects.length = 0;
  q.returns.length = 0;
  q.sets.length = 0;
  q.recompute.mockReset().mockResolvedValue(undefined);
});

describe('retireEvse', () => {
  it('answers 404 for an unknown EVSE', async () => {
    q.selects.push([]);
    await expect(retireEvse('sta_1', 9, ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'EVSE_NOT_FOUND',
    });
  });

  it('changes nothing for an EVSE already retired', async () => {
    q.selects.push([evseRow({ evseRetiredAt: RETIRED })]);
    expect(await retireEvse('sta_1', 1, ctx)).toEqual({ retiredAt: RETIRED, changed: false });
    expect(q.sets).toHaveLength(0);
  });

  it('refuses an EVSE whose connector is in use', async () => {
    q.selects.push([evseRow()], [{ id: 'con_1' }], []);
    await expect(retireEvse('sta_1', 1, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONNECTOR_OCCUPIED',
    });
  });

  it('refuses an EVSE with an active session', async () => {
    q.selects.push([evseRow()], [], [{ id: 'ses_1' }]);
    await expect(retireEvse('sta_1', 1, ctx)).rejects.toMatchObject({
      code: 'CONNECTOR_OCCUPIED',
    });
  });

  it('refuses a reserved EVSE', async () => {
    q.selects.push([evseRow()], [], [], [{ id: 1 }]);
    await expect(retireEvse('sta_1', 1, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EVSE_RESERVED',
    });
  });

  it('retires, audits, recomputes, announces and sends Inoperative', async () => {
    q.selects.push([evseRow()], [], [], []);
    q.returns.push([{ retiredAt: RETIRED }]);
    expect(await retireEvse('sta_1', 1, ctx)).toEqual({ retiredAt: RETIRED, changed: true });
    expect(q.sets[0]).toMatchObject({ retiredAt: expect.any(Date) });
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'sta_1',
      action: 'evse_changed',
      actorUserId: 'usr_1',
      before: { evseId: 1, retiredAt: null },
      after: { evseId: 1, retiredAt: RETIRED },
      notes: 'EVSE 1 retired',
    });
    expect(q.recompute).toHaveBeenCalledWith({ tag: 'client' }, 'sta_1');
    expect(q.publish).toHaveBeenCalledWith({ id: 'sta_1', siteId: 'sit_1' }, log);
    expect(q.sendAvailability).toHaveBeenCalledWith('CS-1', 'Inoperative', log, { evseId: 1 });
  });

  it('reads the EVSE again when a parallel retire won the update', async () => {
    q.selects.push([evseRow()], [], [], [], [evseRow({ evseRetiredAt: RETIRED })]);
    q.returns.push([]);
    expect(await retireEvse('sta_1', 1, ctx)).toEqual({ retiredAt: RETIRED, changed: false });
    expect(q.writeAudit).not.toHaveBeenCalled();
  });

  it('still announces and commands when the availability recompute fails', async () => {
    q.recompute.mockRejectedValue(new Error('db down'));
    q.selects.push([evseRow({ disabledReason: 'maintenance' })], [], [], []);
    q.returns.push([{ retiredAt: RETIRED }]);
    await retireEvse('sta_1', 1, ctx);
    expect(q.publish).toHaveBeenCalled();
    // Inoperative goes to a disabled station too.
    expect(q.sendAvailability).toHaveBeenCalledWith('CS-1', 'Inoperative', log, { evseId: 1 });
  });
});

describe('restoreEvse', () => {
  it('changes nothing for an EVSE not retired', async () => {
    q.selects.push([evseRow()]);
    q.returns.push([]);
    expect(await restoreEvse('sta_1', 1, ctx)).toEqual({ retiredAt: null, changed: false });
    expect(q.publish).not.toHaveBeenCalled();
  });

  it('restores and sends Operative', async () => {
    q.selects.push([evseRow({ evseRetiredAt: RETIRED })]);
    q.returns.push([{ id: 'evs_1' }]);
    expect(await restoreEvse('sta_1', 1, ctx)).toEqual({ retiredAt: null, changed: true });
    expect(q.sets[0]).toMatchObject({ retiredAt: null });
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      before: { evseId: 1, retiredAt: RETIRED },
      after: { evseId: 1, retiredAt: null },
      notes: 'EVSE 1 restored',
    });
    expect(q.sendAvailability).toHaveBeenCalledWith('CS-1', 'Operative', log, { evseId: 1 });
  });

  it('sends no Operative to a disabled station', async () => {
    q.selects.push([evseRow({ evseRetiredAt: RETIRED, disabledReason: 'operator' })]);
    q.returns.push([{ id: 'evs_1' }]);
    await restoreEvse('sta_1', 1, ctx);
    expect(q.writeAudit).toHaveBeenCalled();
    expect(q.sendAvailability).not.toHaveBeenCalled();
  });
});

describe('retireConnector', () => {
  it('answers 404 for an unknown connector', async () => {
    q.selects.push([evseRow()], []);
    await expect(retireConnector('sta_1', 1, 3, ctx)).rejects.toMatchObject({
      statusCode: 404,
      code: 'CONNECTOR_NOT_FOUND',
    });
  });

  it('changes nothing for a connector already retired', async () => {
    q.selects.push([evseRow()], [{ id: 'con_1', retiredAt: RETIRED }]);
    expect(await retireConnector('sta_1', 1, 2, ctx)).toEqual({
      retiredAt: RETIRED,
      changed: false,
    });
  });

  it('refuses a connector in use', async () => {
    q.selects.push([evseRow()], [{ id: 'con_1', retiredAt: null }], [{ id: 'con_1' }], []);
    await expect(retireConnector('sta_1', 1, 2, ctx)).rejects.toMatchObject({
      code: 'CONNECTOR_OCCUPIED',
    });
  });

  it('retires and sends Inoperative for the connector', async () => {
    q.selects.push([evseRow()], [{ id: 'con_1', retiredAt: null }], [], [], []);
    q.returns.push([{ retiredAt: RETIRED }]);
    expect(await retireConnector('sta_1', 1, 2, ctx)).toEqual({
      retiredAt: RETIRED,
      changed: true,
    });
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      before: { evseId: 1, connectorId: 2, retiredAt: null },
      after: { evseId: 1, connectorId: 2, retiredAt: RETIRED },
      notes: 'Connector 2 of EVSE 1 retired',
    });
    expect(q.sendAvailability).toHaveBeenCalledWith('CS-1', 'Inoperative', log, {
      evseId: 1,
      connectorId: 2,
    });
  });

  it('reads the connector again when a parallel retire won', async () => {
    q.selects.push(
      [evseRow()],
      [{ id: 'con_1', retiredAt: null }],
      [],
      [],
      [],
      [{ id: 'con_1', retiredAt: RETIRED }],
    );
    q.returns.push([]);
    expect(await retireConnector('sta_1', 1, 2, ctx)).toEqual({
      retiredAt: RETIRED,
      changed: false,
    });
  });
});

describe('restoreConnector', () => {
  it('changes nothing for a connector not retired', async () => {
    q.selects.push([evseRow()], [{ id: 'con_1', retiredAt: null }]);
    q.returns.push([]);
    expect(await restoreConnector('sta_1', 1, 2, ctx)).toEqual({
      retiredAt: null,
      changed: false,
    });
  });

  it('restores and sends Operative for the connector', async () => {
    q.selects.push([evseRow()], [{ id: 'con_1', retiredAt: RETIRED }]);
    q.returns.push([{ id: 'con_1' }]);
    expect(await restoreConnector('sta_1', 1, 2, ctx)).toEqual({
      retiredAt: null,
      changed: true,
    });
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      before: { connectorId: 2, retiredAt: RETIRED },
      notes: 'Connector 2 of EVSE 1 restored',
    });
    expect(q.sendAvailability).toHaveBeenCalledWith('CS-1', 'Operative', log, {
      evseId: 1,
      connectorId: 2,
    });
  });
});
