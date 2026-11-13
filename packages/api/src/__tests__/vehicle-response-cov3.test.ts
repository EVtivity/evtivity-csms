// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The vehicle reply helpers: the last place a charger sent a vehicle id, the
// claim body rule, and the status and code of every vehicle service error.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';

const q = vi.hoisted(() => ({ rows: [] as unknown[], calls: 0 }));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) chain[method] = () => chain;
  chain['orderBy'] = () => Promise.resolve(q.rows);
  return {
    ...actual,
    db: {
      selectDistinctOn: () => {
        q.calls += 1;
        return chain;
      },
    },
  };
});

import {
  replyVehicleServiceError,
  vehicleClaimBody,
  vehicleLastSeen,
} from '../lib/vehicle-response.js';
import {
  AutochargeClaimRequiredError,
  SessionNoVehicleIdError,
  SessionNotFoundError,
  VehicleBlockedError,
  VehicleDriverNotFoundError,
  VehicleIdInUseError,
  VehicleIdInvalidError,
  VehicleIdRequiredError,
  VehicleNotFoundError,
} from '../services/vehicle.service.js';

beforeEach(() => {
  q.rows = [];
  q.calls = 0;
});

describe('vehicleLastSeen', () => {
  it('reads nothing for no vehicle', async () => {
    expect((await vehicleLastSeen([], null)).size).toBe(0);
    expect(q.calls).toBe(0);
  });

  it('maps each vehicle to its last station, site and time', async () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    q.rows = [
      { vehicleId: 'veh_1', stationId: 'CS-1', siteName: 'Depot', at },
      { vehicleId: 'veh_2', stationId: 'CS-2', siteName: undefined, at: null },
      { vehicleId: null, stationId: 'CS-3', siteName: 'X', at },
    ];
    const seen = await vehicleLastSeen(['veh_1', 'veh_2'], ['sit_1']);
    expect([...seen.entries()]).toEqual([
      ['veh_1', { stationId: 'CS-1', siteName: 'Depot', at }],
      ['veh_2', { stationId: 'CS-2', siteName: null, at: new Date(0) }],
    ]);
  });
});

describe('vehicleClaimBody', () => {
  it('takes either a vehicle id or a new vehicle, never both or neither', () => {
    expect(vehicleClaimBody.safeParse({ vehicleId: 'veh_000000000001' }).success).toBe(true);
    expect(vehicleClaimBody.safeParse({ vehicle: { make: 'A', model: 'B' } }).success).toBe(true);
    expect(vehicleClaimBody.safeParse({}).success).toBe(false);
    expect(
      vehicleClaimBody.safeParse({
        vehicleId: 'veh_000000000001',
        vehicle: { make: 'A', model: 'B' },
      }).success,
    ).toBe(false);
  });
});

describe('replyVehicleServiceError', () => {
  function fakeReply(): { reply: FastifyReply; sent: { status?: number; body?: unknown } } {
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return Promise.resolve(this);
      },
    } as unknown as FastifyReply;
    return { reply, sent };
  }

  it.each([
    [new VehicleNotFoundError(), 404, 'VEHICLE_NOT_FOUND'],
    [new VehicleDriverNotFoundError(), 404, 'DRIVER_NOT_FOUND'],
    [new SessionNotFoundError(), 404, 'SESSION_NOT_FOUND'],
    [new VehicleIdInUseError(), 409, 'VEHICLE_ID_IN_USE'],
    [new AutochargeClaimRequiredError(), 409, 'AUTOCHARGE_CLAIM_REQUIRED'],
    [new SessionNoVehicleIdError(), 409, 'SESSION_NO_VEHICLE_ID'],
    [new VehicleIdRequiredError(), 400, 'VEHICLE_ID_REQUIRED'],
    [new VehicleBlockedError(), 403, 'VEHICLE_BLOCKED_BY_OPERATOR'],
  ])('answers %s', async (err, status, code) => {
    const { reply, sent } = fakeReply();
    expect(await replyVehicleServiceError(reply, err)).toBe(true);
    expect(sent.status).toBe(status);
    expect(sent.body).toMatchObject({ code });
  });

  it('names the invalid field', async () => {
    const { reply, sent } = fakeReply();
    expect(await replyVehicleServiceError(reply, new VehicleIdInvalidError('evccid'))).toBe(true);
    expect(sent).toEqual({
      status: 400,
      body: {
        error: 'Not a valid EVCCID or MAC address',
        code: 'VALIDATION_ERROR',
        details: { field: 'evccid' },
      },
    });
  });

  it('leaves any other error to the caller', async () => {
    const { reply, sent } = fakeReply();
    expect(await replyVehicleServiceError(reply, new Error('x'))).toBe(false);
    expect(sent).toEqual({});
  });
});
