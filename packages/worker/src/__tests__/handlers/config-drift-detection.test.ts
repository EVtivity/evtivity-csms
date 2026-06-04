// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Drizzle chain mock: each builder call returns the chain; awaiting it pulls the
// next preset result off the queue. The handler issues queries in this order
// per template: templates SELECT (once at top), then per-template
// [targetStations SELECT, stationConfigurations SELECT].
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]): void {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'innerJoin', 'leftJoin'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  let awaited = false;
  chain['then'] = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ): Promise<unknown> => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  chargingStations: {
    id: 'chargingStations.id',
    isOnline: 'chargingStations.isOnline',
    siteId: 'chargingStations.siteId',
    vendorId: 'chargingStations.vendorId',
    model: 'chargingStations.model',
  },
  configTemplates: {},
  stationConfigurations: {
    stationId: 'stationConfigurations.stationId',
  },
}));

const mockEq = vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] }));
const mockAnd = vi.fn((...c: unknown[]) => ({ and: c }));
const mockInArray = vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] }));
vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => mockEq(a[0], a[1]),
  and: (...a: unknown[]) => mockAnd(...a),
  inArray: (...a: unknown[]) => mockInArray(a[0], a[1]),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('configDriftDetectionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
  });

  it('does nothing when there are no templates', async () => {
    setupDbResults([]); // templates

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('skips templates with no variables', async () => {
    setupDbResults([{ id: 'tpl_empty', variables: [], targetFilter: null }]);

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    // No target-station query issued for an empty-variable template.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('skips a template whose filter matches no stations', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [{ component: 'AuthCtrlr', variable: 'Enabled', value: 'true' }],
          targetFilter: { siteId: 'site_x' },
        },
      ],
      [], // targetStations empty
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('emits config.driftDetected when a station value differs from the template', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [{ component: 'AuthCtrlr', variable: 'Enabled', value: 'true' }],
          targetFilter: null,
        },
      ],
      [{ id: 'sta_drift' }], // targetStations
      [{ stationId: 'sta_drift', component: 'AuthCtrlr', variable: 'Enabled', value: 'false' }],
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'config.driftDetected',
        stationId: 'sta_drift',
        sessionId: null,
        siteId: null,
      }),
    );
    expect(log.info).toHaveBeenCalledWith({ driftCount: 1 }, 'Configuration drift detected');
  });

  it('emits drift when the expected variable is entirely missing on the station', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [{ component: 'TxCtrlr', variable: 'TxStartPoint', value: 'EVConnected' }],
          targetFilter: null,
        },
      ],
      [{ id: 'sta_missing' }],
      [], // station has no configurations at all -> find() returns undefined
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('"stationId":"sta_missing"'),
    );
  });

  it('does not emit drift when all station values match', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [
            { component: 'AuthCtrlr', variable: 'Enabled', value: 'true' },
            { component: 'TxCtrlr', variable: 'TxStartPoint', value: 'EVConnected' },
          ],
          targetFilter: null,
        },
      ],
      [{ id: 'sta_ok' }],
      [
        { stationId: 'sta_ok', component: 'AuthCtrlr', variable: 'Enabled', value: 'true' },
        {
          stationId: 'sta_ok',
          component: 'TxCtrlr',
          variable: 'TxStartPoint',
          value: 'EVConnected',
        },
      ],
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('emits at most one drift event per station even with multiple mismatches (break)', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [
            { component: 'AuthCtrlr', variable: 'Enabled', value: 'true' },
            { component: 'TxCtrlr', variable: 'TxStartPoint', value: 'EVConnected' },
          ],
          targetFilter: null,
        },
      ],
      [{ id: 'sta_two_drift' }],
      [
        { stationId: 'sta_two_drift', component: 'AuthCtrlr', variable: 'Enabled', value: 'false' },
        {
          stationId: 'sta_two_drift',
          component: 'TxCtrlr',
          variable: 'TxStartPoint',
          value: 'Authorized',
        },
      ],
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ driftCount: 1 }, 'Configuration drift detected');
  });

  it('groups configurations by station and emits drift only for the drifting station', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [{ component: 'AuthCtrlr', variable: 'Enabled', value: 'true' }],
          targetFilter: null,
        },
      ],
      [{ id: 'sta_ok' }, { id: 'sta_bad' }],
      [
        { stationId: 'sta_ok', component: 'AuthCtrlr', variable: 'Enabled', value: 'true' },
        { stationId: 'sta_bad', component: 'AuthCtrlr', variable: 'Enabled', value: 'false' },
      ],
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('"stationId":"sta_bad"'),
    );
  });

  it('applies siteId, vendorId, and model filter conditions when present', async () => {
    setupDbResults(
      [
        {
          id: 'tpl_filtered',
          variables: [{ component: 'AuthCtrlr', variable: 'Enabled', value: 'true' }],
          targetFilter: { siteId: 'site_1', vendorId: 'ven_1', model: 'ModelX' },
        },
      ],
      [], // no stations -> short-circuit, we only care about the filter build
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await configDriftDetectionHandler(log);

    // isOnline + siteId + vendorId + model = 4 eq conditions for this template.
    expect(mockEq).toHaveBeenCalledWith('chargingStations.isOnline', true);
    expect(mockEq).toHaveBeenCalledWith('chargingStations.siteId', 'site_1');
    expect(mockEq).toHaveBeenCalledWith('chargingStations.vendorId', 'ven_1');
    expect(mockEq).toHaveBeenCalledWith('chargingStations.model', 'ModelX');
    expect(mockInArray).not.toHaveBeenCalled();
  });

  it('continues to the next template when SSE publish fails (best-effort)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('redis down'));
    setupDbResults(
      [
        {
          id: 'tpl_1',
          variables: [{ component: 'AuthCtrlr', variable: 'Enabled', value: 'true' }],
          targetFilter: null,
        },
      ],
      [{ id: 'sta_drift' }],
      [{ stationId: 'sta_drift', component: 'AuthCtrlr', variable: 'Enabled', value: 'false' }],
    );

    const { configDriftDetectionHandler } =
      await import('../../handlers/config-drift-detection.js');
    await expect(configDriftDetectionHandler(log)).resolves.toBeUndefined();

    // driftCount still incremented despite the publish failure.
    expect(log.info).toHaveBeenCalledWith({ driftCount: 1 }, 'Configuration drift detected');
  });
});
