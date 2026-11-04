// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDepartureSite: vi.fn(),
  getDepartureVehicle: vi.fn(),
  getVehicleBatteryCapacity: vi.fn(),
  getDepartureSchedule: vi.fn(),
  getDeparture: vi.fn(),
  insertDepartureSchedule: vi.fn(),
  updateDepartureSchedule: vi.fn(),
  deleteDepartureSchedule: vi.fn(),
  futureScheduleOccurrences: vi.fn(),
  insertDeparture: vi.fn(),
  insertScheduleOccurrences: vi.fn(),
  updateScheduledDeparture: vi.fn(),
  cancelScheduledDepartures: vi.fn(),
  deleteUnusedScheduleOccurrences: vi.fn(),
  markSitePlanStale: vi.fn(),
  vehicleDayDepartureCounts: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }) },
  vehicleDepartureAuditLog: { name: 'vehicle_departure_audit_log' },
  ...mocks,
}));

const {
  auditDeparturesImported,
  cancelDeparture,
  checkExpectedArrival,
  createDeparture,
  createDepartureSchedule,
  deleteDepartureSchedule,
  expandScheduleOccurrences,
  updateDeparture,
  updateDepartureSchedule,
} = await import('../departure.service.js');

const NOW = new Date('2026-11-02T10:00:00Z'); // Monday
const actor = { actor: 'operator' as const, actorUserId: 'usr_1' };

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    actor,
    siteScope: ['sit_a', 'sit_b'] as string[] | null,
    now: () => NOW,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onChange: vi.fn(),
    ...overrides,
  };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vds_1',
    vehicleId: 'veh_1',
    siteId: 'sit_a',
    daysOfWeek: [1, 2, 3, 4, 5],
    departureTime: '05:30',
    targetKind: 'energy',
    targetEnergyKwh: '120.00',
    targetSocPercent: null,
    priority: 5,
    validFrom: null,
    validTo: null,
    isActive: true,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function departure(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vdp_1',
    vehicleId: 'veh_1',
    siteId: 'sit_a',
    scheduleId: null,
    occurrenceDate: null,
    departureAt: new Date('2026-11-03T05:30:00Z'),
    targetKind: 'energy',
    targetEnergyKwh: '120.00',
    targetSocPercent: null,
    priority: 5,
    source: 'manual',
    overridden: false,
    status: 'scheduled',
    outcome: null,
    ...overrides,
  };
}

function auditCalls(): Array<Record<string, unknown>> {
  return mocks.writeAudit.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  mocks.getDepartureSite.mockImplementation((id: string) =>
    Promise.resolve(id === 'sit_gone' ? null : { id, timezone: 'UTC' }),
  );
  mocks.getDepartureVehicle.mockResolvedValue({
    id: 'veh_1',
    driverId: 'drv_1',
    batteryCapacityKwh: 400,
    inFleet: true,
  });
  mocks.getVehicleBatteryCapacity.mockResolvedValue(400);
  mocks.insertDepartureSchedule.mockImplementation((values: Record<string, unknown>) =>
    Promise.resolve(schedule(values)),
  );
  mocks.insertScheduleOccurrences.mockImplementation((rows: unknown[]) => Promise.resolve(rows));
  mocks.insertDeparture.mockImplementation((values: Record<string, unknown>) =>
    Promise.resolve(departure(values)),
  );
  mocks.futureScheduleOccurrences.mockResolvedValue([]);
  mocks.cancelScheduledDepartures.mockImplementation((ids: string[]) =>
    Promise.resolve(ids.map((id) => departure({ id, status: 'cancelled' }))),
  );
  mocks.markSitePlanStale.mockResolvedValue(true);
  mocks.vehicleDayDepartureCounts.mockResolvedValue(new Map());
  // By default nothing refers to an occurrence, so every one can be removed.
  mocks.deleteUnusedScheduleOccurrences.mockImplementation((ids: string[]) =>
    Promise.resolve(ids.map((id) => departure({ id }))),
  );
});

describe('schedules', () => {
  const input = {
    fleetId: 'flt_1',
    vehicleId: 'veh_1',
    siteId: 'sit_a',
    daysOfWeek: [5, 1, 2, 3, 4, 1],
    departureTime: '05:30',
    target: { kind: 'energy' as const, targetKwh: 120 },
  };

  it('creates a schedule, its upcoming occurrences, the audit row and a stale plan', async () => {
    const c = ctx();
    const result = await createDepartureSchedule(input, c);
    expect(mocks.insertDepartureSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        daysOfWeek: [1, 2, 3, 4, 5],
        priority: 5,
        targetEnergyKwh: '120.00',
      }),
      { tx: true },
    );
    // Monday 10:00 UTC: the Monday 05:30 departure has left; Tuesday to Friday
    // and next Monday remain within today plus 7 days.
    const dates = (
      mocks.insertScheduleOccurrences.mock.calls[0]?.[0] as Array<{ occurrenceDate: string }>
    ).map((o) => o.occurrenceDate);
    expect(dates).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09']);
    expect(result.occurrencesCreated).toBe(5);
    const [row] = auditCalls();
    expect(row).toMatchObject({
      action: 'schedule_created',
      entityId: 'vds_1',
      before: null,
      after: expect.objectContaining({
        siteId: 'sit_a',
        auditSiteId: 'sit_a',
        auditSiteIds: ['sit_a'],
      }),
    });
    expect(mocks.markSitePlanStale).toHaveBeenCalledWith('sit_a', 'schedule_created', c.log);
    expect(c.onChange).toHaveBeenCalledWith({ kind: 'schedule', id: 'vds_1', siteIds: ['sit_a'] });
  });

  it('answers SITE_NOT_FOUND for a site outside the caller sites or one that does not exist', async () => {
    await expect(
      createDepartureSchedule({ ...input, siteId: 'sit_c' }, ctx()),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'SITE_NOT_FOUND',
    });
    await expect(
      createDepartureSchedule({ ...input, siteId: 'sit_gone' }, ctx({ siteScope: null })),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
    expect(mocks.insertDepartureSchedule).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('answers VEHICLE_NOT_IN_FLEET for a vehicle of another driver or no vehicle', async () => {
    mocks.getDepartureVehicle.mockResolvedValueOnce({
      id: 'veh_1',
      driverId: 'drv_9',
      batteryCapacityKwh: null,
      inFleet: false,
    });
    await expect(createDepartureSchedule(input, ctx())).rejects.toMatchObject({
      statusCode: 400,
      code: 'VEHICLE_NOT_IN_FLEET',
    });
    mocks.getDepartureVehicle.mockResolvedValueOnce(null);
    await expect(createDepartureSchedule(input, ctx())).rejects.toMatchObject({
      code: 'VEHICLE_NOT_IN_FLEET',
    });
    expect(mocks.insertDepartureSchedule).not.toHaveBeenCalled();
  });

  it('refuses a SoC target when the vehicle has no battery capacity', async () => {
    mocks.getDepartureVehicle.mockResolvedValueOnce({
      id: 'veh_1',
      driverId: 'drv_1',
      batteryCapacityKwh: null,
      inFleet: true,
    });
    await expect(
      createDepartureSchedule({ ...input, target: { kind: 'soc', targetSoc: 80 } }, ctx()),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('refuses bad days, times, priorities and date ranges before any write', async () => {
    for (const bad of [
      { daysOfWeek: [] },
      { daysOfWeek: [0] },
      { departureTime: '24:00' },
      { priority: 11 },
      { target: { kind: 'energy' as const, targetKwh: 0 } },
      { target: { kind: 'soc' as const, targetSoc: 101 } },
      { validFrom: '2026-12-01', validTo: '2026-11-01' },
      { notes: 'x'.repeat(501) },
    ]) {
      await expect(
        createDepartureSchedule({ ...input, ...bad }, ctx()),
        JSON.stringify(bad),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    expect(mocks.insertDepartureSchedule).not.toHaveBeenCalled();
  });

  it('moves only future occurrences no person overrode, cancels dropped days, adds new ones', async () => {
    const before = schedule();
    mocks.getDepartureSchedule.mockResolvedValue(before);
    mocks.updateDepartureSchedule.mockImplementation(
      (_id: string, changes: Record<string, unknown>) => Promise.resolve(schedule(changes)),
    );
    // The writer returns only scheduled, non-overridden, future occurrences.
    mocks.futureScheduleOccurrences.mockResolvedValue([
      departure({
        id: 'vdp_tue',
        scheduleId: 'vds_1',
        occurrenceDate: '2026-11-03',
        source: 'schedule',
      }),
      departure({
        id: 'vdp_wed',
        scheduleId: 'vds_1',
        occurrenceDate: '2026-11-04',
        source: 'schedule',
      }),
    ]);
    mocks.updateScheduledDeparture.mockImplementation(
      (id: string, changes: Record<string, unknown>) =>
        Promise.resolve(departure({ id, ...changes })),
    );
    const c = ctx();
    const result = await updateDepartureSchedule(
      'vds_1',
      { daysOfWeek: [2, 4], departureTime: '06:00', siteId: 'sit_b' },
      c,
    );
    expect(mocks.futureScheduleOccurrences).toHaveBeenCalledWith('vds_1', NOW, { tx: true });
    expect(mocks.updateScheduledDeparture).toHaveBeenCalledTimes(1);
    expect(mocks.updateScheduledDeparture).toHaveBeenCalledWith(
      'vdp_tue',
      expect.objectContaining({ siteId: 'sit_b', departureAt: new Date('2026-11-03T06:00:00Z') }),
      { tx: true },
    );
    expect(mocks.deleteUnusedScheduleOccurrences).toHaveBeenCalledWith(['vdp_wed'], NOW, {
      tx: true,
    });
    expect(mocks.cancelScheduledDepartures).toHaveBeenCalledWith([], { tx: true });
    expect(result).toMatchObject({
      occurrencesUpdated: 1,
      occurrencesRemoved: 1,
      occurrencesCancelled: 0,
    });
    // The audit row belongs to the new site and names both.
    const [row] = auditCalls();
    expect(row).toMatchObject({
      action: 'schedule_updated',
      before: expect.objectContaining({ siteId: 'sit_a', auditSiteId: 'sit_b' }),
      after: expect.objectContaining({ siteId: 'sit_b', auditSiteId: 'sit_b' }),
    });
    expect([...(row?.['after'] as { auditSiteIds: string[] }).auditSiteIds].sort()).toEqual([
      'sit_a',
      'sit_b',
    ]);
    expect(mocks.markSitePlanStale).toHaveBeenCalledWith('sit_a', 'schedule_updated', c.log);
    expect(mocks.markSitePlanStale).toHaveBeenCalledWith('sit_b', 'schedule_updated', c.log);
  });

  it('removes unused future occurrences when the schedule is turned off, cancels used ones', async () => {
    mocks.getDepartureSchedule.mockResolvedValue(schedule());
    mocks.updateDepartureSchedule.mockResolvedValue(schedule({ isActive: false }));
    mocks.futureScheduleOccurrences.mockResolvedValue([
      departure({ id: 'vdp_tue', scheduleId: 'vds_1', occurrenceDate: '2026-11-03' }),
      departure({ id: 'vdp_wed', scheduleId: 'vds_1', occurrenceDate: '2026-11-04' }),
    ]);
    // Wednesday already has a session bound, so the writer keeps it.
    mocks.deleteUnusedScheduleOccurrences.mockResolvedValue([departure({ id: 'vdp_tue' })]);
    const c = ctx();
    const result = await updateDepartureSchedule('vds_1', { isActive: false }, c);
    expect(mocks.updateScheduledDeparture).not.toHaveBeenCalled();
    expect(mocks.cancelScheduledDepartures).toHaveBeenCalledWith(['vdp_wed'], { tx: true });
    expect(result).toMatchObject({ occurrencesRemoved: 1, occurrencesCancelled: 1 });
    expect(mocks.insertScheduleOccurrences).not.toHaveBeenCalled();
    expect(auditCalls()[0]?.['notes']).toBe(
      '1 upcoming departures removed, 1 upcoming departures cancelled',
    );
  });

  it('writes nothing for a schedule edit that changes nothing', async () => {
    mocks.getDepartureSchedule.mockResolvedValue(schedule());
    const c = ctx();
    const result = await updateDepartureSchedule(
      'vds_1',
      {
        daysOfWeek: [5, 4, 3, 2, 1],
        departureTime: '05:30',
        target: { kind: 'energy', targetKwh: 120 },
        priority: 5,
        siteId: 'sit_a',
        notes: null,
      },
      c,
    );
    expect(result.schedule.id).toBe('vds_1');
    expect(mocks.updateDepartureSchedule).not.toHaveBeenCalled();
    expect(mocks.futureScheduleOccurrences).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.markSitePlanStale).not.toHaveBeenCalled();
    expect(c.onChange).not.toHaveBeenCalled();
  });

  it('writes only the changed fields and leaves occurrences alone for a notes edit', async () => {
    mocks.getDepartureSchedule.mockResolvedValue(schedule());
    mocks.updateDepartureSchedule.mockResolvedValue(schedule({ notes: 'Route 12' }));
    await updateDepartureSchedule('vds_1', { priority: 5, notes: 'Route 12' }, ctx());
    expect(mocks.updateDepartureSchedule).toHaveBeenCalledWith(
      'vds_1',
      { notes: 'Route 12' },
      {
        tx: true,
      },
    );
    expect(mocks.futureScheduleOccurrences).not.toHaveBeenCalled();
    expect(auditCalls()[0]).toMatchObject({
      after: expect.objectContaining({ entityKind: 'schedule', notes: 'Route 12' }),
    });
  });

  it('expands from the schedule as stored now, read with a shared lock', async () => {
    // The schedule changed to 07:15 after the caller decided to expand it.
    mocks.getDepartureSchedule.mockResolvedValue(
      schedule({ departureTime: '07:15', daysOfWeek: [2] }),
    );
    await expandScheduleOccurrences('vds_1', NOW);
    expect(mocks.getDepartureSchedule).toHaveBeenCalledWith(
      'vds_1',
      { tx: true },
      { forShare: true },
    );
    const rows = mocks.insertScheduleOccurrences.mock.calls[0]?.[0] as Array<{
      departureAt: Date;
    }>;
    expect(rows.map((r) => r.departureAt.toISOString())).toEqual(['2026-11-03T07:15:00.000Z']);
  });

  it('skips occurrences on a local day that already holds 20 departures of the vehicle', async () => {
    mocks.getDepartureSchedule.mockResolvedValue(schedule({ daysOfWeek: [2, 3] }));
    mocks.vehicleDayDepartureCounts.mockResolvedValue(new Map([['2026-11-03', 20]]));
    await expandScheduleOccurrences('vds_1', NOW);
    expect(mocks.vehicleDayDepartureCounts).toHaveBeenCalledWith('veh_1', 'UTC', { tx: true });
    const rows = mocks.insertScheduleOccurrences.mock.calls[0]?.[0] as Array<{
      occurrenceDate: string;
    }>;
    expect(rows.map((r) => r.occurrenceDate)).not.toContain('2026-11-03');
    expect(rows.map((r) => r.occurrenceDate)).toContain('2026-11-04');
  });

  it('expands nothing for a schedule that was deleted or turned off meanwhile', async () => {
    mocks.getDepartureSchedule.mockResolvedValueOnce(null);
    expect(await expandScheduleOccurrences('vds_1', NOW)).toEqual([]);
    mocks.getDepartureSchedule.mockResolvedValueOnce(schedule({ isActive: false }));
    expect(await expandScheduleOccurrences('vds_1', NOW)).toEqual([]);
    expect(mocks.insertScheduleOccurrences).not.toHaveBeenCalled();
  });

  it('answers DEPARTURE_SCHEDULE_NOT_FOUND outside the caller sites', async () => {
    mocks.getDepartureSchedule.mockResolvedValue(schedule({ siteId: 'sit_c' }));
    await expect(updateDepartureSchedule('vds_1', { priority: 7 }, ctx())).rejects.toMatchObject({
      statusCode: 404,
      code: 'DEPARTURE_SCHEDULE_NOT_FOUND',
    });
    await expect(deleteDepartureSchedule('vds_1', ctx())).rejects.toMatchObject({
      code: 'DEPARTURE_SCHEDULE_NOT_FOUND',
    });
    mocks.getDepartureSchedule.mockResolvedValue(null);
    await expect(deleteDepartureSchedule('vds_1', ctx({ siteScope: null }))).rejects.toMatchObject({
      code: 'DEPARTURE_SCHEDULE_NOT_FOUND',
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('deletes a schedule and cancels its future occurrences no person overrode', async () => {
    mocks.getDepartureSchedule.mockResolvedValue(schedule());
    mocks.futureScheduleOccurrences.mockResolvedValue([
      departure({ id: 'vdp_tue', scheduleId: 'vds_1' }),
      departure({ id: 'vdp_wed', scheduleId: 'vds_1' }),
    ]);
    const result = await deleteDepartureSchedule('vds_1', ctx());
    expect(mocks.cancelScheduledDepartures).toHaveBeenCalledWith(['vdp_tue', 'vdp_wed'], {
      tx: true,
    });
    expect(mocks.deleteDepartureSchedule).toHaveBeenCalledWith('vds_1', { tx: true });
    expect(result.occurrencesCancelled).toBe(2);
    expect(auditCalls()[0]).toMatchObject({
      action: 'schedule_deleted',
      entityId: null,
      entityIdSnapshot: 'vds_1',
      after: null,
      before: expect.objectContaining({ auditSiteId: 'sit_a' }),
    });
  });
});

describe('departures', () => {
  const input = {
    fleetId: 'flt_1',
    vehicleId: 'veh_1',
    siteId: 'sit_a',
    departureAt: new Date('2026-11-03T05:30:00Z'),
    target: { kind: 'soc' as const, targetSoc: 90 },
    source: 'import' as const,
  };

  it('creates a departure from an external source through the same entry point', async () => {
    const c = ctx();
    const created = await createDeparture(input, c);
    expect(mocks.insertDeparture).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'import',
        targetKind: 'soc',
        targetSocPercent: 90,
        priority: 5,
      }),
      { tx: true },
    );
    expect(created.id).toBe('vdp_1');
    expect(auditCalls()[0]).toMatchObject({
      action: 'departure_created',
      after: expect.objectContaining({ auditSiteId: 'sit_a', auditSiteIds: ['sit_a'] }),
    });
    expect(mocks.markSitePlanStale).toHaveBeenCalledWith('sit_a', 'departure_created', c.log);
  });

  it('leaves the stale mark and the change event to a caller that defers them, and still audits', async () => {
    const c = ctx({ deferChangeEffects: true });
    await createDeparture({ ...input, source: 'import' }, c);
    expect(auditCalls()[0]).toMatchObject({ action: 'departure_created' });
    expect(mocks.markSitePlanStale).not.toHaveBeenCalled();
    expect(c.onChange).not.toHaveBeenCalled();
  });

  it('takes departures 5 minutes to 30 days ahead only', async () => {
    for (const at of [
      new Date(NOW.getTime() + 4 * 60_000),
      new Date(NOW.getTime() + 31 * 86_400_000),
      new Date(Number.NaN),
    ]) {
      await expect(createDeparture({ ...input, departureAt: at }, ctx())).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    expect(mocks.insertDeparture).not.toHaveBeenCalled();
  });

  it('refuses a 21st scheduled departure of a vehicle on one local day, on create and on a move', async () => {
    mocks.vehicleDayDepartureCounts.mockResolvedValue(new Map([['2026-11-03', 20]]));
    await expect(createDeparture(input, ctx())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'departureAt' },
    });
    expect(mocks.insertDeparture).not.toHaveBeenCalled();
    // Another day still takes one.
    await createDeparture({ ...input, departureAt: new Date('2026-11-04T05:30:00Z') }, ctx());
    expect(mocks.insertDeparture).toHaveBeenCalledTimes(1);

    mocks.getDeparture.mockResolvedValue(
      departure({ departureAt: new Date('2026-11-04T05:30:00Z') }),
    );
    await expect(
      updateDeparture('vdp_1', { departureAt: new Date('2026-11-03T06:00:00Z') }, ctx()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'departureAt' } });
    expect(mocks.vehicleDayDepartureCounts).toHaveBeenLastCalledWith(
      'veh_1',
      'UTC',
      { tx: true },
      'vdp_1',
    );
    expect(mocks.updateScheduledDeparture).not.toHaveBeenCalled();
  });

  it('refuses a SoC departure for a vehicle without battery capacity', async () => {
    mocks.getDepartureVehicle.mockResolvedValueOnce({
      id: 'veh_1',
      driverId: 'drv_1',
      batteryCapacityKwh: null,
      inFleet: true,
    });
    await expect(createDeparture(input, ctx())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('marks an edited departure overridden', async () => {
    mocks.getDeparture.mockResolvedValue(departure());
    mocks.updateScheduledDeparture.mockImplementation(
      (id: string, changes: Record<string, unknown>) =>
        Promise.resolve(departure({ id, ...changes })),
    );
    await updateDeparture('vdp_1', { priority: 9 }, ctx());
    expect(mocks.updateScheduledDeparture).toHaveBeenCalledWith(
      'vdp_1',
      { overridden: true, priority: 9 },
      { tx: true },
    );
    expect(auditCalls()[0]).toMatchObject({
      action: 'departure_updated',
      after: expect.objectContaining({ entityKind: 'departure' }),
    });
  });

  it('writes nothing for a departure edit that changes nothing', async () => {
    mocks.getDeparture.mockResolvedValue(departure());
    const c = ctx();
    const result = await updateDeparture(
      'vdp_1',
      {
        priority: 5,
        departureAt: new Date('2026-11-03T05:30:00Z'),
        target: { kind: 'energy', targetKwh: 120 },
      },
      c,
    );
    expect(result.id).toBe('vdp_1');
    expect(mocks.updateScheduledDeparture).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.markSitePlanStale).not.toHaveBeenCalled();
    expect(c.onChange).not.toHaveBeenCalled();
  });

  it('answers DEPARTURE_NOT_SCHEDULED for an edit of a completed departure', async () => {
    mocks.getDeparture.mockResolvedValue(departure({ status: 'completed', outcome: 'met' }));
    await expect(updateDeparture('vdp_1', { priority: 9 }, ctx())).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEPARTURE_NOT_SCHEDULED',
    });
    expect(mocks.updateScheduledDeparture).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('answers DEPARTURE_NOT_SCHEDULED when the row completed between the read and the write', async () => {
    mocks.getDeparture.mockResolvedValue(departure());
    mocks.updateScheduledDeparture.mockResolvedValue(null);
    await expect(updateDeparture('vdp_1', { priority: 9 }, ctx())).rejects.toMatchObject({
      code: 'DEPARTURE_NOT_SCHEDULED',
    });
  });

  it('answers DEPARTURE_NOT_FOUND for a departure outside the caller sites', async () => {
    mocks.getDeparture.mockResolvedValue(departure({ siteId: 'sit_c' }));
    await expect(cancelDeparture('vdp_1', ctx())).rejects.toMatchObject({
      statusCode: 404,
      code: 'DEPARTURE_NOT_FOUND',
    });
    mocks.getDeparture.mockResolvedValue(null);
    await expect(updateDeparture('vdp_1', {}, ctx())).rejects.toMatchObject({
      code: 'DEPARTURE_NOT_FOUND',
    });
  });

  it('cancels once: a second cancel changes nothing and writes no second audit row', async () => {
    mocks.getDeparture.mockResolvedValueOnce(departure());
    const c = ctx();
    const first = await cancelDeparture('vdp_1', c);
    expect(first).toMatchObject({ changed: true, departure: { status: 'cancelled' } });
    mocks.getDeparture.mockResolvedValueOnce(departure({ status: 'cancelled' }));
    const second = await cancelDeparture('vdp_1', c);
    expect(second.changed).toBe(false);
    expect(mocks.cancelScheduledDepartures).toHaveBeenCalledTimes(1);
    expect(auditCalls().filter((r) => r['action'] === 'departure_cancelled')).toHaveLength(1);
    expect(mocks.markSitePlanStale).toHaveBeenCalledTimes(1);
    expect(c.onChange).toHaveBeenCalledTimes(1);
  });

  it('refuses to cancel a completed departure', async () => {
    mocks.getDeparture.mockResolvedValue(departure({ status: 'completed', outcome: 'short' }));
    await expect(cancelDeparture('vdp_1', ctx())).rejects.toMatchObject({
      code: 'DEPARTURE_NOT_SCHEDULED',
    });
  });

  it('logs a failed change hook and still returns the committed change', async () => {
    const c = ctx({ onChange: vi.fn().mockRejectedValue(new Error('redis down')) });
    await expect(createDeparture(input, c)).resolves.toMatchObject({ id: 'vdp_1' });
    expect(c.log.warn).toHaveBeenCalled();
  });
});

describe('imports', () => {
  it('writes one audit row per site, each scoped to its own site', async () => {
    await auditDeparturesImported(
      'flt_1',
      [
        { siteId: 'sit_a', created: 3, updated: 1 },
        { siteId: 'sit_b', created: 2, updated: 0 },
      ],
      ctx(),
    );
    const rows = auditCalls();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r['after'] as { auditSiteIds: string[] }).auditSiteIds)).toEqual([
      ['sit_a'],
      ['sit_b'],
    ]);
    expect(rows[0]).toMatchObject({
      action: 'departures_imported',
      entityId: 'flt_1',
      after: expect.objectContaining({ entityKind: 'import' }),
    });
  });
});

describe('checkExpectedArrival', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const departure = new Date('2026-11-03T18:00:00Z');

  it('takes an arrival before the departure and a whole state of charge of 0 to 100', () => {
    expect(() => {
      checkExpectedArrival(new Date('2026-11-03T12:00:00Z'), 35, departure, now);
    }).not.toThrow();
    expect(() => {
      checkExpectedArrival(null, null, departure, now);
    }).not.toThrow();
    expect(() => {
      checkExpectedArrival(undefined, 0, departure, now);
    }).not.toThrow();
  });

  it('refuses an arrival at or after the departure, or not a valid time', () => {
    for (const at of [departure, new Date('2026-11-03T19:00:00Z'), new Date(Number.NaN)]) {
      expect(() => {
        checkExpectedArrival(at, null, departure, now);
      }).toThrow(expect.objectContaining({ details: { field: 'expectedArrivalAt' } }));
    }
  });

  it('refuses a state of charge outside 0 to 100 or not whole', () => {
    for (const soc of [-1, 101, 40.5]) {
      expect(() => {
        checkExpectedArrival(undefined, soc, departure, now);
      }).toThrow(expect.objectContaining({ details: { field: 'expectedArrivalSocPercent' } }));
    }
  });
});
