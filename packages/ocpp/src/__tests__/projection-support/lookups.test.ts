// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { DomainEvent } from '@evtivity/lib';
import { createProjectionLookups } from '../../server/projection-support/lookups.js';

function makeSql(): { sql: postgres.Sql; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  return { sql: query as unknown as postgres.Sql, query };
}

function makeEvent(aggregateId: string, payload: Record<string, unknown>): DomainEvent {
  return {
    eventType: 'station.Connected',
    aggregateType: 'ChargingStation',
    aggregateId,
    payload,
    occurredAt: new Date(),
  };
}

describe('createProjectionLookups', () => {
  it('caches the station uuid after the first lookup', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([{ id: 'uuid-1' }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveStationUuid('CS-1')).toBe('uuid-1');
    expect(await lookups.resolveStationUuid('CS-1')).toBe('uuid-1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not cache an unknown station', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'uuid-1' }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveStationUuid('CS-1')).toBeNull();
    expect(await lookups.resolveStationUuid('CS-1')).toBe('uuid-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('invalidateStationCache forces a new station and site lookup', async () => {
    const { sql, query } = makeSql();
    query
      .mockResolvedValueOnce([{ id: 'uuid-1' }])
      .mockResolvedValueOnce([{ site_id: 'site-1' }])
      .mockResolvedValueOnce([{ id: 'uuid-1' }])
      .mockResolvedValueOnce([{ site_id: 'site-2' }]);
    const lookups = createProjectionLookups(sql);

    await lookups.resolveStationUuid('CS-1');
    expect(await lookups.resolveSiteId('uuid-1')).toBe('site-1');

    lookups.invalidateStationCache('CS-1');

    expect(await lookups.resolveStationUuid('CS-1')).toBe('uuid-1');
    expect(await lookups.resolveSiteId('uuid-1')).toBe('site-2');
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('caches a station without a site as null', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([{ site_id: null }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveSiteId('uuid-1')).toBeNull();
    expect(await lookups.resolveSiteId('uuid-1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches the site name by station uuid', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([{ name: 'Depot' }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveSiteName('uuid-1')).toBe('Depot');
    expect(await lookups.resolveSiteName('uuid-1')).toBe('Depot');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches a found EVSE and skips the cache on bypass', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([{ id: 'evse-1' }]).mockResolvedValueOnce([{ id: 'evse-1' }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveEvseUuid('uuid-1', 1)).toBe('evse-1');
    expect(await lookups.resolveEvseUuid('uuid-1', 1)).toBe('evse-1');
    expect(query).toHaveBeenCalledTimes(1);

    expect(await lookups.resolveEvseUuid('uuid-1', 1, true)).toBe('evse-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not cache a missing EVSE', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'evse-1' }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveEvseUuid('uuid-1', 1)).toBeNull();
    expect(await lookups.resolveEvseUuid('uuid-1', 1)).toBe('evse-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns null for EVSE 0 without a query', async () => {
    const { sql, query } = makeSql();
    const lookups = createProjectionLookups(sql);

    expect(await lookups.resolveEvseUuid('uuid-1', 0)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('getStationUuid uses and caches the event stationDbId', async () => {
    const { sql, query } = makeSql();
    const lookups = createProjectionLookups(sql);

    expect(await lookups.getStationUuid(makeEvent('CS-1', { stationDbId: 'uuid-1' }))).toBe(
      'uuid-1',
    );
    expect(await lookups.resolveStationUuid('CS-1')).toBe('uuid-1');
    expect(query).not.toHaveBeenCalled();
  });

  it('getStationUuid falls back to a lookup without stationDbId', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValueOnce([{ id: 'uuid-1' }]);
    const lookups = createProjectionLookups(sql);

    expect(await lookups.getStationUuid(makeEvent('CS-1', {}))).toBe('uuid-1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps caches per instance', async () => {
    const { sql, query } = makeSql();
    query.mockResolvedValue([{ id: 'uuid-1' }]);

    await createProjectionLookups(sql).resolveStationUuid('CS-1');
    await createProjectionLookups(sql).resolveStationUuid('CS-1');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
