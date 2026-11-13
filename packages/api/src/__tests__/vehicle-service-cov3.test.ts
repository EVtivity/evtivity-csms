// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The vehicle writer against a fake database: create, update, delete, the
// operator block, the session vehicle id claim, the operator session vehicle
// assignment and the driver's own session vehicle. Each Autocharge invariant
// answers its error, constraint violations map to the service errors, and
// every change writes its audit rows.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => ({
  selects: [] as unknown[],
  executes: [] as unknown[],
  returns: [] as unknown[],
  inserts: [] as unknown[],
  sets: [] as unknown[],
  writeAudit: vi.fn(),
  markSitePlanStale: vi.fn(),
  isFleetChargingEnabled: vi.fn(),
}));

function settle(value: unknown): Promise<unknown> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);
}

function selectChain(): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'for', 'limit', 'orderBy']) b[method] = () => b;
  b['then'] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    settle(q.selects.shift()).then(res, rej);
  return b;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fake: Record<string, unknown> = {
    select: () => selectChain(),
    selectDistinct: () => selectChain(),
    execute: () => settle(q.executes.shift()),
    insert: () => ({
      values: (v: unknown) => {
        q.inserts.push(v);
        return { returning: () => settle(q.returns.shift()) };
      },
    }),
    update: () => ({
      set: (s: unknown) => {
        q.sets.push(s);
        const after = {
          returning: () => settle(q.returns.shift()),
          then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
        };
        return { where: () => after };
      },
    }),
    delete: () => ({ where: () => ({ returning: () => settle(q.returns.shift()) }) }),
  };
  fake['transaction'] = (fn: (tx: unknown) => unknown) => fn(fake);
  return {
    ...actual,
    db: fake,
    writeAudit: q.writeAudit,
    markSitePlanStale: q.markSitePlanStale,
    isFleetChargingEnabled: q.isFleetChargingEnabled,
  };
});

import {
  AutochargeClaimRequiredError,
  SessionNoVehicleIdError,
  SessionNotActiveError,
  SessionNotFoundError,
  SessionVehicleOperatorAssignedError,
  VehicleBlockedError,
  VehicleDriverNotFoundError,
  VehicleIdInUseError,
  VehicleIdInvalidError,
  VehicleIdRequiredError,
  VehicleNotFoundError,
  assignSessionVehicle,
  claimSessionVehicleId,
  createVehicle,
  deleteVehicle,
  setDriverSessionVehicle,
  setVehicleBlocked,
  updateVehicle,
} from '../services/vehicle.service.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';

const VIN = '1HGCM82633A004352';
const MAC = 'AABBCCDDEEFF';
const log = { warn: vi.fn() };
const driverActor: AuditActorInfo = {
  actor: 'driver',
  actorUserId: null,
  actorDriverId: 'drv_1',
  actorApiKeyId: null,
  actorLabel: null,
};
const operatorActor: AuditActorInfo = {
  actor: 'operator',
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};

function vehicle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'veh_1',
    driverId: 'drv_1',
    make: 'Tesla',
    model: 'Model 3',
    vin: null,
    evccid: null,
    autochargeEnabled: false,
    autochargeBlockedAt: null,
    ...overrides,
  };
}

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('pg'), {
    code,
    ...(constraint != null ? { constraint_name: constraint } : {}),
  });
}

/** The action of every audit row written, in order. */
const auditActions = () => q.writeAudit.mock.calls.map((c) => (c[1] as { action: string }).action);

beforeEach(() => {
  q.selects.length = 0;
  q.executes.length = 0;
  q.returns.length = 0;
  q.inserts.length = 0;
  q.sets.length = 0;
  q.isFleetChargingEnabled.mockReset().mockResolvedValue(true);
});

describe('createVehicle', () => {
  it('normalizes the ids, stores the battery fields with two decimals and audits', async () => {
    q.returns.push([vehicle({ vin: VIN, evccid: MAC })]);
    const created = await createVehicle(
      'drv_1',
      {
        make: 'Tesla',
        model: 'Model 3',
        vin: ` ${VIN.toLowerCase()} `,
        evccid: 'aa:bb:cc:dd:ee:ff',
        batteryCapacityKwh: 75,
        maxChargePowerKw: 250.5,
        preconditioningPowerKw: 3,
        preconditioningMinutes: 30,
      },
      operatorActor,
      log,
    );
    expect(created.id).toBe('veh_1');
    expect(q.inserts[0]).toMatchObject({
      driverId: 'drv_1',
      vin: VIN,
      evccid: MAC,
      autochargeEnabled: false,
      batteryCapacityKwh: '75.00',
      maxChargePowerKw: '250.50',
      preconditioningPowerKw: '3.00',
      preconditioningMinutes: 30,
      year: null,
      color: null,
    });
    expect(auditActions()).toEqual(['created']);
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'veh_1',
      before: null,
      actor: 'operator',
    });
  });

  it('stores a blank id as null and leaves the preconditioning minutes to the default', async () => {
    q.returns.push([vehicle()]);
    await createVehicle(
      'drv_1',
      { make: 'A', model: 'B', vin: '  ', evccid: '' },
      operatorActor,
      log,
    );
    expect(q.inserts[0]).toMatchObject({ vin: null, evccid: null, batteryCapacityKwh: null });
    expect(q.inserts[0]).not.toHaveProperty('preconditioningMinutes');
  });

  it('refuses an invalid VIN or EVCCID', async () => {
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B', vin: 'short' }, operatorActor, log),
    ).rejects.toMatchObject({ field: 'vin' });
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B', evccid: 'AB CD' }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleIdInvalidError);
    expect(q.inserts).toHaveLength(0);
  });

  it('refuses Autocharge without a vehicle id', async () => {
    await expect(
      createVehicle(
        'drv_1',
        { make: 'A', model: 'B', autochargeEnabled: true },
        operatorActor,
        log,
      ),
    ).rejects.toBeInstanceOf(VehicleIdRequiredError);
  });

  it("refuses a vehicle id that is another driver's card", async () => {
    q.executes.push([{ hit: 1 }]);
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B', vin: VIN }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleIdInUseError);
  });

  it('refuses a driver Autocharge on an id another vehicle uses', async () => {
    q.selects.push([{ id: 'veh_9' }]);
    await expect(
      createVehicle(
        'drv_1',
        { make: 'A', model: 'B', vin: VIN, autochargeEnabled: true },
        driverActor,
        log,
      ),
    ).rejects.toBeInstanceOf(VehicleIdInUseError);
  });

  it('needs a driver to have seen every id in an own session', async () => {
    q.selects.push([], [{ value: VIN }]);
    await expect(
      createVehicle(
        'drv_1',
        { make: 'A', model: 'B', vin: VIN, evccid: MAC, autochargeEnabled: true },
        driverActor,
        log,
      ),
    ).rejects.toBeInstanceOf(AutochargeClaimRequiredError);
  });

  it('lets a driver turn Autocharge on for ids seen in an own session', async () => {
    q.selects.push([], [{ value: MAC }]);
    q.returns.push([vehicle({ evccid: MAC, autochargeEnabled: true })]);
    await createVehicle(
      'drv_1',
      { make: 'A', model: 'B', evccid: MAC, autochargeEnabled: true },
      driverActor,
      log,
    );
    expect(q.inserts[0]).toMatchObject({ autochargeEnabled: true });
  });

  it('lets an operator turn Autocharge on without the session check', async () => {
    q.returns.push([vehicle({ vin: VIN, autochargeEnabled: true })]);
    await createVehicle(
      'drv_1',
      { make: 'A', model: 'B', vin: VIN, autochargeEnabled: true },
      operatorActor,
      log,
    );
    expect(q.selects).toHaveLength(0);
    expect(q.inserts).toHaveLength(1);
  });

  it.each([
    [pgError('23505', 'uq_vehicles_autocharge_vin'), VehicleIdInUseError],
    [pgError('23505', 'uq_vehicles_autocharge_evccid'), VehicleIdInUseError],
    [pgError('23514', 'vehicles_autocharge_id_check'), VehicleIdRequiredError],
    [pgError('23503'), VehicleDriverNotFoundError],
  ])('maps a constraint violation of the insert', async (err, expected) => {
    q.returns.push(err);
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B' }, operatorActor, log),
    ).rejects.toBeInstanceOf(expected);
  });

  it('passes on any other error, an unrelated unique violation included', async () => {
    const other = pgError('23505', 'some_other_index');
    q.returns.push(other);
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B' }, operatorActor, log),
    ).rejects.toBe(other);
  });

  it('fails when the insert returns no row', async () => {
    q.returns.push([]);
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B' }, operatorActor, log),
    ).rejects.toThrow('Vehicle insert returned no row');
    expect(q.writeAudit).not.toHaveBeenCalled();
  });

  it('refuses a battery value out of range before any write', async () => {
    await expect(
      createVehicle('drv_1', { make: 'A', model: 'B', batteryCapacityKwh: 0 }, operatorActor, log),
    ).rejects.toThrow(/batteryCapacityKwh/);
    expect(q.inserts).toHaveLength(0);
  });
});

describe('updateVehicle', () => {
  it('answers not found for a vehicle of another driver', async () => {
    q.selects.push([]);
    await expect(
      updateVehicle('drv_1', 'veh_1', { make: 'X' }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it('refuses a driver Autocharge on a blocked vehicle', async () => {
    q.selects.push([vehicle({ vin: VIN, autochargeBlockedAt: new Date() })]);
    await expect(
      updateVehicle('drv_1', 'veh_1', { autochargeEnabled: true }, driverActor, log),
    ).rejects.toBeInstanceOf(VehicleBlockedError);
  });

  it('lets an operator enable a blocked vehicle and audits autocharge_enabled', async () => {
    const before = vehicle({ vin: VIN, autochargeBlockedAt: new Date() });
    q.selects.push([before]);
    q.executes.push([]);
    q.returns.push([{ ...before, autochargeEnabled: true }]);
    const after = await updateVehicle(
      'drv_1',
      'veh_1',
      { autochargeEnabled: true },
      operatorActor,
      log,
    );
    expect(after.autochargeEnabled).toBe(true);
    expect(auditActions()).toEqual(['autocharge_enabled']);
  });

  it('sets only the sent fields and audits updated', async () => {
    q.selects.push([vehicle()]);
    q.returns.push([vehicle({ make: 'Kia' })]);
    await updateVehicle(
      'drv_1',
      'veh_1',
      {
        make: 'Kia',
        model: 'EV9',
        year: '2025',
        licensePlate: 'AB-1',
        color: 'red',
        bodyType: 'suv',
        batteryCapacityKwh: 99.8,
        maxChargePowerKw: null,
        preconditioningPowerKw: 2,
        preconditioningMinutes: 45,
      },
      operatorActor,
      log,
    );
    expect(q.sets[0]).toMatchObject({
      make: 'Kia',
      model: 'EV9',
      year: '2025',
      licensePlate: 'AB-1',
      color: 'red',
      bodyType: 'suv',
      batteryCapacityKwh: '99.80',
      maxChargePowerKw: null,
      preconditioningPowerKw: '2.00',
      preconditioningMinutes: 45,
    });
    expect(q.sets[0]).not.toHaveProperty('vin');
    expect(q.executes).toHaveLength(0);
    expect(auditActions()).toEqual(['updated']);
  });

  it('refuses Autocharge on once no id is left', async () => {
    q.selects.push([vehicle({ vin: VIN, autochargeEnabled: true })]);
    await expect(
      updateVehicle('drv_1', 'veh_1', { vin: '' }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleIdRequiredError);
  });

  it("checks other drivers' cards when an id changes", async () => {
    q.selects.push([vehicle()]);
    q.executes.push([{ hit: 1 }]);
    await expect(
      updateVehicle('drv_1', 'veh_1', { evccid: MAC }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleIdInUseError);
  });

  it('runs the driver claim check when an id changes while Autocharge is on', async () => {
    q.selects.push([vehicle({ vin: VIN, autochargeEnabled: true })], [], []);
    q.executes.push([]);
    await expect(
      updateVehicle('drv_1', 'veh_1', { evccid: MAC }, driverActor, log),
    ).rejects.toBeInstanceOf(AutochargeClaimRequiredError);
  });

  it('audits autocharge_disabled when Autocharge turns off', async () => {
    const before = vehicle({ vin: VIN, autochargeEnabled: true });
    q.selects.push([before]);
    q.returns.push([{ ...before, autochargeEnabled: false }]);
    await updateVehicle('drv_1', 'veh_1', { autochargeEnabled: false }, driverActor, log);
    expect(auditActions()).toEqual(['autocharge_disabled']);
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({ before, actor: 'driver' });
  });

  it('answers not found when the update returns no row', async () => {
    q.selects.push([vehicle()]);
    q.returns.push([]);
    await expect(
      updateVehicle('drv_1', 'veh_1', { make: 'X' }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it('maps a unique violation of the update', async () => {
    q.selects.push([vehicle()]);
    q.returns.push(pgError('23505', 'uq_vehicles_autocharge_vin'));
    await expect(
      updateVehicle('drv_1', 'veh_1', { make: 'X' }, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleIdInUseError);
  });
});

describe('deleteVehicle', () => {
  it('answers not found when nothing was deleted', async () => {
    q.returns.push([]);
    await expect(deleteVehicle('drv_1', 'veh_1', operatorActor, log)).rejects.toBeInstanceOf(
      VehicleNotFoundError,
    );
    expect(q.writeAudit).not.toHaveBeenCalled();
  });

  it('audits the delete with no entity id and the snapshot', async () => {
    q.returns.push([vehicle()]);
    await deleteVehicle('drv_1', 'veh_1', operatorActor, log);
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'deleted',
      entityId: null,
      entityIdSnapshot: 'veh_1',
      after: null,
    });
  });
});

describe('setVehicleBlocked', () => {
  it('answers not found for an unknown vehicle', async () => {
    q.selects.push([]);
    await expect(
      setVehicleBlocked('drv_1', 'veh_1', true, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it('writes nothing when the block already matches', async () => {
    const row = vehicle({ autochargeBlockedAt: new Date() });
    q.selects.push([row]);
    const result = await setVehicleBlocked('drv_1', 'veh_1', true, operatorActor, log);
    expect(result).toBe(row);
    expect(q.sets).toHaveLength(0);
    expect(q.writeAudit).not.toHaveBeenCalled();
  });

  it('blocks with a time and audits autocharge_blocked', async () => {
    q.selects.push([vehicle()]);
    q.returns.push([vehicle({ autochargeBlockedAt: new Date() })]);
    await setVehicleBlocked('drv_1', 'veh_1', true, operatorActor, log);
    expect((q.sets[0] as { autochargeBlockedAt: unknown }).autochargeBlockedAt).toBeInstanceOf(
      Date,
    );
    expect(auditActions()).toEqual(['autocharge_blocked']);
  });

  it('unblocks and audits autocharge_unblocked', async () => {
    q.selects.push([vehicle({ autochargeBlockedAt: new Date() })]);
    q.returns.push([vehicle()]);
    await setVehicleBlocked('drv_1', 'veh_1', false, operatorActor, log);
    expect(q.sets[0]).toMatchObject({ autochargeBlockedAt: null });
    expect(auditActions()).toEqual(['autocharge_unblocked']);
  });

  it('answers not found when the update returns no row', async () => {
    q.selects.push([vehicle()]);
    q.returns.push([]);
    await expect(
      setVehicleBlocked('drv_1', 'veh_1', true, operatorActor, log),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });
});

describe('claimSessionVehicleId', () => {
  const session = (overrides: Record<string, unknown> = {}) => ({
    driverId: 'drv_1',
    vehicleId: null,
    value: VIN,
    type: 'VIN',
    ...overrides,
  });
  const claim = (target: Parameters<typeof claimSessionVehicleId>[0]['target'], enable = false) =>
    claimSessionVehicleId(
      { sessionId: 'ses_1', driverId: 'drv_1', target, enableAutocharge: enable },
      driverActor,
      log,
    );

  it('answers not found for a session of another driver or none', async () => {
    q.selects.push([session({ driverId: 'drv_2' })]);
    await expect(claim({ vehicleId: 'veh_1' })).rejects.toBeInstanceOf(SessionNotFoundError);
    q.selects.push([]);
    await expect(claim({ vehicleId: 'veh_1' })).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('answers no vehicle id when the charger sent none or another type', async () => {
    q.selects.push([session({ value: null })]);
    await expect(claim({ vehicleId: 'veh_1' })).rejects.toBeInstanceOf(SessionNoVehicleIdError);
    q.selects.push([session({ type: 'ISO14443' })]);
    await expect(claim({ vehicleId: 'veh_1' })).rejects.toBeInstanceOf(SessionNoVehicleIdError);
  });

  it('answers not found for an existing vehicle of another driver', async () => {
    q.selects.push([session()], []);
    await expect(claim({ vehicleId: 'veh_1' })).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it('refuses a driver enabling Autocharge on a blocked vehicle', async () => {
    q.selects.push([session()], [vehicle({ autochargeBlockedAt: new Date() })]);
    await expect(claim({ vehicleId: 'veh_1' }, true)).rejects.toBeInstanceOf(VehicleBlockedError);
  });

  it('stores the VIN on an existing vehicle, enables Autocharge, links the session and audits', async () => {
    const existing = vehicle({ evccid: MAC });
    q.selects.push(
      [session({ vehicleId: 'veh_0' })],
      [existing],
      [],
      [{ value: VIN }, { value: MAC }],
    );
    q.executes.push([]);
    q.returns.push([{ ...existing, vin: VIN, autochargeEnabled: true }]);
    const result = await claim({ vehicleId: 'veh_1' }, true);
    expect(result).toMatchObject({ created: false, previousSessionVehicleId: 'veh_0' });
    expect(q.sets[0]).toMatchObject({ vin: VIN, autochargeEnabled: true });
    expect(q.sets[1]).toMatchObject({ vehicleId: 'veh_1' });
    expect(auditActions()).toEqual(['vehicle_id_claimed', 'vehicle_changed']);
    expect(q.writeAudit.mock.calls[1]?.[1]).toMatchObject({
      entityId: 'ses_1',
      before: { vehicleId: 'veh_0' },
      after: { vehicleId: 'veh_1' },
    });
  });

  it('stores an EVCCID without the claim check when Autocharge stays off, no session audit for the same vehicle', async () => {
    q.selects.push([session({ type: 'EVCCID', value: MAC, vehicleId: 'veh_1' })], [vehicle()]);
    q.executes.push([]);
    q.returns.push([vehicle({ evccid: MAC })]);
    await claim({ vehicleId: 'veh_1' });
    expect(q.sets[0]).toMatchObject({ evccid: MAC });
    expect(q.sets[0]).not.toHaveProperty('autochargeEnabled');
    expect(auditActions()).toEqual(['vehicle_id_claimed']);
  });

  it('answers driver not found for an erased or missing driver when creating', async () => {
    q.selects.push([session()], [{ id: 'drv_1', erasedAt: new Date() }]);
    await expect(claim({ vehicle: { make: 'A', model: 'B' } })).rejects.toBeInstanceOf(
      VehicleDriverNotFoundError,
    );
    q.selects.push([session()], []);
    await expect(claim({ vehicle: { make: 'A', model: 'B' } })).rejects.toBeInstanceOf(
      VehicleDriverNotFoundError,
    );
  });

  it('creates a vehicle with the session EVCCID and audits created and claimed', async () => {
    q.selects.push(
      [session({ type: 'MacAddress', value: MAC })],
      [{ id: 'drv_1', erasedAt: null }],
    );
    q.executes.push([]);
    q.returns.push([vehicle({ id: 'veh_new', evccid: MAC })]);
    const result = await claim({ vehicle: { make: 'A', model: 'B', year: '2024' } }, true);
    expect(result).toMatchObject({ created: true, previousSessionVehicleId: null });
    expect(q.inserts[0]).toMatchObject({
      driverId: 'drv_1',
      make: 'A',
      model: 'B',
      year: '2024',
      evccid: MAC,
      autochargeEnabled: true,
    });
    expect(auditActions()).toEqual(['created', 'vehicle_id_claimed', 'vehicle_changed']);
  });

  it('creates with the session VIN and a null year', async () => {
    q.selects.push([session()], [{ id: 'drv_1', erasedAt: null }]);
    q.executes.push([]);
    q.returns.push([vehicle({ id: 'veh_new', vin: VIN })]);
    await claim({ vehicle: { make: 'A', model: 'B' } });
    expect(q.inserts[0]).toMatchObject({ vin: VIN, year: null });
  });

  it('answers not found when the write returns no vehicle', async () => {
    q.selects.push([session()], [{ id: 'drv_1', erasedAt: null }]);
    q.executes.push([]);
    q.returns.push([]);
    await expect(claim({ vehicle: { make: 'A', model: 'B' } })).rejects.toBeInstanceOf(
      VehicleNotFoundError,
    );
  });

  it('maps a unique violation of the claim write', async () => {
    q.selects.push([session()], [{ id: 'drv_1', erasedAt: null }]);
    q.executes.push([]);
    q.returns.push(pgError('23505', 'uq_vehicles_autocharge_vin'));
    await expect(claim({ vehicle: { make: 'A', model: 'B' } }, true)).rejects.toBeInstanceOf(
      VehicleIdInUseError,
    );
  });
});

describe('assignSessionVehicle', () => {
  const active = (overrides: Record<string, unknown> = {}) => ({
    driverId: 'drv_1',
    stationId: 'sta_1',
    siteId: 'sit_1',
    status: 'active',
    vehicleId: null,
    ...overrides,
  });
  const assign = (siteScope: string[] | null = null) =>
    assignSessionVehicle({ sessionId: 'ses_1', vehicleId: 'veh_1', siteScope }, operatorActor, log);

  it('answers not found for an unknown session or one outside the scope', async () => {
    q.selects.push([]);
    await expect(assign()).rejects.toBeInstanceOf(SessionNotFoundError);
    q.selects.push([active()]);
    await expect(assign(['sit_2'])).rejects.toBeInstanceOf(SessionNotFoundError);
    q.selects.push([active({ siteId: null })]);
    await expect(assign(['sit_1'])).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('refuses a session that is not active', async () => {
    q.selects.push([active({ status: 'completed' })]);
    await expect(assign()).rejects.toBeInstanceOf(SessionNotActiveError);
  });

  it('answers not found for a vehicle the session cannot take', async () => {
    q.selects.push([active()], []);
    await expect(assign()).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it('changes nothing for the vehicle the session already has', async () => {
    q.selects.push([active({ vehicleId: 'veh_1' })], [{ id: 'veh_1' }]);
    const result = await assign(['sit_1']);
    expect(result).toEqual({
      sessionId: 'ses_1',
      vehicleId: 'veh_1',
      previousVehicleId: 'veh_1',
      changed: false,
    });
    expect(q.sets).toHaveLength(0);
    expect(q.writeAudit).not.toHaveBeenCalled();
    expect(q.markSitePlanStale).not.toHaveBeenCalled();
  });

  it('assigns, audits the session and the vehicle and marks the plan stale', async () => {
    q.selects.push([active({ vehicleId: 'veh_0' })], [{ id: 'veh_1' }]);
    const result = await assign();
    expect(result).toMatchObject({ previousVehicleId: 'veh_0', changed: true });
    expect(q.sets[0]).toMatchObject({ vehicleId: 'veh_1', vehicleAssignedByOperator: true });
    expect(auditActions()).toEqual(['vehicle_changed', 'updated']);
    expect(q.markSitePlanStale).toHaveBeenCalledWith(
      'sit_1',
      'session_vehicle_assigned',
      undefined,
      { departureAwareOnly: true },
    );
  });

  it('marks no plan for a session without a site', async () => {
    q.selects.push([active({ siteId: null })], [{ id: 'veh_1' }]);
    await assign();
    expect(q.writeAudit).toHaveBeenCalledTimes(2);
    expect(q.markSitePlanStale).not.toHaveBeenCalled();
  });
});

describe('setDriverSessionVehicle', () => {
  const own = (overrides: Record<string, unknown> = {}) => ({
    siteId: 'sit_1',
    status: 'active',
    vehicleId: null,
    assignedByOperator: false,
    ...overrides,
  });
  const setVehicle = (vehicleId: string | null) =>
    setDriverSessionVehicle({ sessionId: 'ses_1', driverId: 'drv_1', vehicleId }, driverActor, log);

  it('answers not found for a session of another driver', async () => {
    q.selects.push([]);
    await expect(setVehicle('veh_1')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("answers not found for another driver's vehicle", async () => {
    q.selects.push([own()], [{ driverId: 'drv_2' }]);
    await expect(setVehicle('veh_1')).rejects.toBeInstanceOf(VehicleNotFoundError);
    q.selects.push([own()], []);
    await expect(setVehicle('veh_1')).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it('changes nothing for the same vehicle', async () => {
    q.selects.push([own({ vehicleId: 'veh_1' })], [{ driverId: 'drv_1' }]);
    expect(await setVehicle('veh_1')).toEqual({ vehicleId: 'veh_1', changed: false });
    expect(q.writeAudit).not.toHaveBeenCalled();
  });

  it('keeps a vehicle an operator assigned while the depot plan charges the session', async () => {
    q.selects.push(
      [own({ vehicleId: 'veh_0', assignedByOperator: true })],
      [{ driverId: 'drv_1' }],
    );
    q.executes.push([{ planned: 1 }]);
    await expect(setVehicle('veh_1')).rejects.toBeInstanceOf(SessionVehicleOperatorAssignedError);
    expect(q.sets).toHaveLength(0);
  });

  it('replaces an operator vehicle when the site plan does not charge it', async () => {
    q.selects.push([own({ vehicleId: 'veh_0', assignedByOperator: true })]);
    q.executes.push([]);
    const result = await setVehicle(null);
    expect(result).toEqual({ vehicleId: null, changed: true });
    expect(q.sets[0]).toMatchObject({ vehicleId: null, vehicleAssignedByOperator: false });
    expect(q.writeAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'vehicle_changed',
      before: { vehicleId: 'veh_0' },
      after: { vehicleId: null },
    });
    expect(q.markSitePlanStale).toHaveBeenCalledWith(
      'sit_1',
      'session_vehicle_changed',
      undefined,
      { departureAwareOnly: true },
    );
  });

  it('skips the plan read with Fleet Charging off', async () => {
    q.isFleetChargingEnabled.mockResolvedValue(false);
    q.selects.push(
      [own({ vehicleId: 'veh_0', assignedByOperator: true })],
      [{ driverId: 'drv_1' }],
    );
    await setVehicle('veh_1');
    expect(q.executes).toHaveLength(0);
    expect(q.sets).toHaveLength(1);
  });

  it('marks no plan for a session without a site', async () => {
    q.selects.push([own({ siteId: null })], [{ driverId: 'drv_1' }]);
    await setVehicle('veh_1');
    expect(q.writeAudit).toHaveBeenCalledTimes(1);
    expect(q.markSitePlanStale).not.toHaveBeenCalled();
  });
});
