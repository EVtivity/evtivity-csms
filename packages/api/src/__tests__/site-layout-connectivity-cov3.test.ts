// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectResult } = vi.hoisted(() => ({
  selectResult: { rows: [] as unknown[], error: null as Error | null },
}));

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/ocpp-operations.js')),
  db: {
    select: () => {
      const self: Record<string, unknown> = {};
      self['from'] = () => self;
      self['where'] = () =>
        selectResult.error != null
          ? Promise.reject(selectResult.error)
          : Promise.resolve(selectResult.rows);
      return self;
    },
  },
}));
vi.mock('@evtivity/services/station-sim.service', () => ({ stationLinkSummaries: vi.fn() }));
vi.mock('../lib/sim.js', () => ({
  readSimSettings: vi.fn(),
  isSimFeatureOn: () => false,
  simProviderRegistry: () => ({ enabledProviders: vi.fn() }),
}));

import { activeNetworkLink, readLayoutWiredLinks } from '../lib/site-layout-connectivity.js';

const log = { warn: vi.fn() };
const cfg = (
  stationId: string,
  component: string,
  variable: string,
  value: string | null,
  instance: string | null = null,
) => ({ stationId, component, variable, value, instance });

beforeEach(() => {
  selectResult.rows = [];
  selectResult.error = null;
});

describe('activeNetworkLink (cov3)', () => {
  it('tells nothing when the active slot has no interface reported', () => {
    expect(
      activeNetworkLink([
        cfg('s', 'OCPPCommCtrlr', 'ActiveNetworkProfile', ' 2 '),
        cfg('s', 'NetworkConfiguration', 'OcppInterface', 'Wired0', '1'),
      ]),
    ).toBeNull();
    expect(activeNetworkLink([cfg('s', 'OCPPCommCtrlr', 'ActiveNetworkProfile', '')])).toBeNull();
  });
});

describe('readLayoutWiredLinks', () => {
  it('reads nothing for no stations', async () => {
    expect((await readLayoutWiredLinks([], log)).size).toBe(0);
  });

  it('groups the rows per station and keeps the stations with a known link', async () => {
    selectResult.rows = [
      cfg('sta_1', 'OCPPCommCtrlr', 'ActiveNetworkProfile', '1'),
      cfg('sta_1', 'NetworkConfiguration', 'OcppInterface', 'Wireless1', '1'),
      cfg('sta_2', 'OCPPCommCtrlr', 'NetworkConfigurationPriority', '0,1'),
      cfg('sta_2', 'NetworkConfiguration', 'OcppInterface', 'Wired2', '0'),
      cfg('sta_3', 'NetworkConfiguration', 'OcppInterface', 'Any', '0'),
    ];
    const out = await readLayoutWiredLinks(['sta_1', 'sta_2', 'sta_3'], log);
    expect(Object.fromEntries(out)).toEqual({ sta_1: 'wifi', sta_2: 'wired' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a read failure and returns no links', async () => {
    const err = new Error('db down');
    selectResult.error = err;
    const out = await readLayoutWiredLinks(['sta_1'], log);
    expect(out.size).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      { err },
      expect.stringContaining('network interfaces not read'),
    );
  });
});
