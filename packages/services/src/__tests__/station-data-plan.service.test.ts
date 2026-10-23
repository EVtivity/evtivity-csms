// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_PLAN_DEFAULTS, resolveDataPlan } from '@evtivity/lib';
import type { DataPlan } from '@evtivity/lib';

const mocks = vi.hoisted(() => ({
  readStationDataPlans: vi.fn(),
  listSiteStationIds: vi.fn(),
  setStationDataPlan: vi.fn(),
  setSiteDataPlan: vi.fn(),
  writeAudit: vi.fn(),
  getDataPlanValues: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: mocks.where })) })) },
  chargingStations: { id: 'id', stationId: 'station_id' },
  siteAuditLog: { name: 'site_audit_log' },
  stationAuditLog: { name: 'station_audit_log' },
  ...mocks,
}));

import {
  changeSiteDataPlan,
  changeStationDataPlan,
  pushStationDataPlan,
  pushStationDataPlanChanges,
  siteDataPlanImpact,
  snapshotStationDataPlansByOcppIds,
  withStationDataPlanPush,
} from '../station-data-plan.service.js';
import type { StationDataPlanState } from '@evtivity/database';

interface Input {
  id: string;
  stationPlan?: DataPlan | null;
  hasConfirmedSim?: boolean;
  sitePlan?: DataPlan | null;
  isOnline?: boolean;
  protocol?: string;
  kind?: 'ac' | 'dc';
}

function state(input: Input): StationDataPlanState {
  const stationPlan = input.stationPlan ?? null;
  const hasConfirmedSim = input.hasConfirmedSim ?? false;
  const sitePlan = input.sitePlan ?? null;
  return {
    stationId: input.id,
    stationOcppId: `CS-${input.id}`,
    siteId: 'site-1',
    isOnline: input.isOnline ?? true,
    ocppProtocol: input.protocol ?? 'ocpp2.1',
    stationPlan,
    sitePlan,
    hasConfirmedSim,
    ...resolveDataPlan({ stationPlan, hasConfirmedSim, sitePlan }),
    chargingKind: input.kind ?? 'ac',
  };
}

function states(...inputs: Input[]): Map<string, StationDataPlanState> {
  return new Map(inputs.map((i) => [i.id, state(i)]));
}

const pubsub = { publish: vi.fn().mockResolvedValue(undefined) };
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const actor = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};

function published(channel: string): unknown[] {
  return pubsub.publish.mock.calls
    .filter((c) => c[0] === channel)
    .map((c) => JSON.parse(c[1] as string) as unknown);
}

beforeEach(() => {
  pubsub.publish.mockResolvedValue(undefined);
  mocks.getDataPlanValues.mockImplementation((plan: DataPlan) =>
    Promise.resolve(DATA_PLAN_DEFAULTS[plan]),
  );
  mocks.writeAudit.mockResolvedValue(undefined);
});

describe('pushStationDataPlan', () => {
  it('sends the plan values with the heartbeat and an invalidation to online stations only', async () => {
    mocks.readStationDataPlans.mockResolvedValueOnce(
      states({ id: 'a', hasConfirmedSim: true, protocol: 'ocpp1.6' }, { id: 'b', isOnline: false }),
    );
    const pushed = await pushStationDataPlan(['a', 'b'], { pubsub: pubsub as never, log });
    expect(pushed).toEqual(['a']);
    expect(published('cache_invalidate')).toEqual([
      { kind: 'station_data_plan', stationId: 'CS-a' },
    ]);
    const commands = published('ocpp_commands') as {
      stationId: string;
      action: string;
      payload: { key: string; value: string };
      version: string;
    }[];
    expect(commands.every((c) => c.stationId === 'CS-a' && c.version === 'ocpp1.6')).toBe(true);
    expect(commands.map((c) => `${c.payload.key}=${c.payload.value}`)).toContain(
      'HeartbeatInterval=3600',
    );
    expect(commands.map((c) => c.payload.key)).toContain('ClockAlignedDataInterval');
  });

  it('sends only the charging values for a charging scope, without an invalidation', async () => {
    mocks.readStationDataPlans.mockResolvedValueOnce(states({ id: 'a', kind: 'dc' }));
    await pushStationDataPlan(['a'], { pubsub: pubsub as never, scope: 'charging' });
    expect(published('cache_invalidate')).toEqual([]);
    const names = (published('ocpp_commands') as { payload: Record<string, unknown> }[]).map(
      (c) =>
        (
          c.payload['setVariableData'] as { variable: { name: string }; attributeValue: string }[]
        )[0]!.variable.name,
    );
    expect(names).toEqual(['TxUpdatedInterval', 'TxUpdatedMeasurands']);
  });

  it('is fail-open on a publish error', async () => {
    mocks.readStationDataPlans.mockResolvedValueOnce(states({ id: 'a' }));
    pubsub.publish.mockRejectedValue(new Error('redis down'));
    await expect(pushStationDataPlan(['a'], { pubsub: pubsub as never, log })).resolves.toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('pushStationDataPlanChanges', () => {
  it('pushes the full plan on a plan change and the charging values on a kind change', async () => {
    const before = states({ id: 'a' }, { id: 'b' }, { id: 'c' });
    mocks.readStationDataPlans
      .mockResolvedValueOnce(
        states({ id: 'a', hasConfirmedSim: true }, { id: 'b', kind: 'dc' }, { id: 'c' }),
      )
      .mockResolvedValueOnce(states({ id: 'a', hasConfirmedSim: true }))
      .mockResolvedValueOnce(states({ id: 'b', kind: 'dc' }));
    const pushed = await pushStationDataPlanChanges(before, { pubsub: pubsub as never });
    expect(pushed).toEqual(['a', 'b']);
    expect(mocks.readStationDataPlans).toHaveBeenNthCalledWith(2, ['a']);
    expect(mocks.readStationDataPlans).toHaveBeenNthCalledWith(3, ['b']);
  });

  it('withStationDataPlanPush reads before and after the change', async () => {
    mocks.readStationDataPlans
      .mockResolvedValueOnce(states({ id: 'a', hasConfirmedSim: true }))
      .mockResolvedValueOnce(states({ id: 'a' }))
      .mockResolvedValueOnce(states({ id: 'a' }));
    const run = vi.fn().mockResolvedValue('done');
    await expect(
      withStationDataPlanPush(['a', null], run, { pubsub: pubsub as never }),
    ).resolves.toBe('done');
    expect(run).toHaveBeenCalledOnce();
    expect(published('cache_invalidate')).toHaveLength(1);
  });
});

describe('changeStationDataPlan', () => {
  it('writes, audits and pushes when the effective plan changes', async () => {
    mocks.readStationDataPlans
      .mockResolvedValueOnce(states({ id: 'a' }))
      .mockResolvedValueOnce(states({ id: 'a', stationPlan: 'cellular' }))
      .mockResolvedValueOnce(states({ id: 'a', stationPlan: 'cellular' }));
    mocks.setStationDataPlan.mockResolvedValueOnce({ before: null, after: 'cellular' });
    const result = await changeStationDataPlan('a', 'cellular', actor, { pubsub: pubsub as never });
    expect(result).toEqual({
      changed: true,
      before: null,
      after: 'cellular',
      effectiveChanged: true,
    });
    expect(mocks.writeAudit).toHaveBeenCalledOnce();
    const args = mocks.writeAudit.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).toMatchObject({
      action: 'updated',
      notes: 'data_plan_changed',
      before: { dataPlan: null },
      after: { dataPlan: 'cellular' },
    });
    expect(published('cache_invalidate')).toHaveLength(1);
  });

  it('writes no audit row for a no-op', async () => {
    mocks.readStationDataPlans.mockResolvedValueOnce(states({ id: 'a', stationPlan: 'cellular' }));
    mocks.setStationDataPlan.mockResolvedValueOnce(null);
    const result = await changeStationDataPlan('a', 'cellular', actor, { pubsub: pubsub as never });
    expect(result.changed).toBe(false);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('pushes nothing when told not to', async () => {
    mocks.readStationDataPlans.mockResolvedValueOnce(states({ id: 'a' }));
    mocks.setStationDataPlan.mockResolvedValueOnce({ before: null, after: 'cellular' });
    await changeStationDataPlan('a', 'cellular', actor, { pubsub: pubsub as never, push: false });
    expect(pubsub.publish).not.toHaveBeenCalled();
  });
});

describe('site data plan', () => {
  const siteStations = (sitePlan: DataPlan | null) =>
    states(
      { id: 'inherit', sitePlan },
      { id: 'own', stationPlan: 'wifi_or_wired', sitePlan },
      { id: 'sim', hasConfirmedSim: true, sitePlan },
      { id: 'offline', isOnline: false, sitePlan },
    );

  it('counts only the stations that inherit the site plan', async () => {
    mocks.listSiteStationIds.mockResolvedValueOnce(['inherit', 'own', 'sim', 'offline']);
    mocks.readStationDataPlans.mockResolvedValueOnce(siteStations(null));
    expect(await siteDataPlanImpact('site-1', 'cellular')).toBe(2);
  });

  it('audits the site with the count and pushes to the online inheriting stations', async () => {
    mocks.listSiteStationIds.mockResolvedValueOnce(['inherit', 'own', 'sim', 'offline']);
    mocks.setSiteDataPlan.mockResolvedValueOnce({ before: null, after: 'cellular' });
    mocks.readStationDataPlans
      .mockResolvedValueOnce(siteStations(null))
      .mockResolvedValueOnce(siteStations('cellular'))
      .mockResolvedValueOnce(
        new Map(
          [...siteStations('cellular')].filter(([id]) => id === 'inherit' || id === 'offline'),
        ),
      );
    const result = await changeSiteDataPlan('site-1', 'cellular', actor, {
      pubsub: pubsub as never,
    });
    expect(result).toEqual({ changed: true, before: null, after: 'cellular', stationsChanged: 2 });
    expect(mocks.writeAudit.mock.calls[0]![1]).toMatchObject({
      action: 'data_plan_changed',
      notes: 'stationsChanged: 2',
    });
    expect(published('cache_invalidate')).toEqual([
      { kind: 'station_data_plan', stationId: 'CS-inherit' },
    ]);
  });

  it('writes nothing for an unchanged site plan', async () => {
    mocks.listSiteStationIds.mockResolvedValueOnce([]);
    mocks.readStationDataPlans.mockResolvedValueOnce(new Map());
    mocks.setSiteDataPlan.mockResolvedValueOnce(null);
    const result = await changeSiteDataPlan('site-1', null, actor, { pubsub: pubsub as never });
    expect(result.changed).toBe(false);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('snapshotStationDataPlansByOcppIds', () => {
  it('snapshots the existing stations among the identities', async () => {
    mocks.where.mockResolvedValueOnce([{ id: 'sta_1' }]);
    const state = new Map([['sta_1', { stationId: 'sta_1' }]]);
    mocks.readStationDataPlans.mockResolvedValueOnce(state);
    const out = await snapshotStationDataPlansByOcppIds(['CS-1', 'CS-NEW']);
    expect(mocks.readStationDataPlans).toHaveBeenCalledWith(['sta_1']);
    expect(out).toBe(state);
  });

  it('reads nothing for no identity and fails open on a read error', async () => {
    expect((await snapshotStationDataPlansByOcppIds([])).size).toBe(0);
    mocks.where.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.fn();
    expect(
      (
        await snapshotStationDataPlansByOcppIds(['CS-1'], {
          log: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        })
      ).size,
    ).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
