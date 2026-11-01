// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { summariesMock, settingsMock, providersMock } = vi.hoisted(() => ({
  summariesMock: vi.fn(),
  settingsMock: vi.fn(),
  providersMock: vi.fn(),
}));

vi.mock('@evtivity/services/station-sim.service', () => ({
  stationLinkSummaries: summariesMock,
}));

vi.mock('../lib/sim.js', () => ({
  readSimSettings: settingsMock,
  isSimFeatureOn: (s: { on: boolean }) => s.on,
  simProviderRegistry: () => ({ enabledProviders: providersMock }),
}));

import {
  activeNetworkLink,
  layoutOcppVersion,
  readLayoutStationLinks,
} from '../lib/site-layout-connectivity.js';

const log = { warn: vi.fn() };

beforeEach(() => {
  summariesMock.mockReset();
  settingsMock.mockReset();
  providersMock.mockReset();
  log.warn.mockReset();
});

describe('layoutOcppVersion', () => {
  it('names the stored protocol as its OCPP version, null when unknown', () => {
    expect(layoutOcppVersion('ocpp1.6')).toBe('1.6');
    expect(layoutOcppVersion('ocpp2.0.1')).toBe('2.0.1');
    expect(layoutOcppVersion('ocpp2.1')).toBe('2.1');
    expect(layoutOcppVersion(null)).toBeNull();
    expect(layoutOcppVersion('ocpp3')).toBeNull();
    expect(layoutOcppVersion('toString')).toBeNull();
  });
});

describe('activeNetworkLink', () => {
  const row = (
    component: string,
    variable: string,
    value: string,
    instance: string | null = null,
  ) => ({
    component,
    variable,
    value,
    instance,
  });

  it('reads the interface of the active network profile slot', () => {
    const rows = [
      row('OCPPCommCtrlr', 'ActiveNetworkProfile', '2'),
      row('OCPPCommCtrlr', 'NetworkConfigurationPriority', '1,2'),
      row('NetworkConfiguration', 'OcppInterface', 'Wired0', '1'),
      row('NetworkConfiguration', 'OcppInterface', 'Wireless1', '2'),
    ];
    expect(activeNetworkLink(rows)).toBe('wifi');
  });

  it('falls back to the first slot of the priority list, and wired interfaces read as wired', () => {
    const rows = [
      row('OCPPCommCtrlr', 'NetworkConfigurationPriority', '1, 2'),
      row('NetworkConfiguration', 'OcppInterface', 'Wired0', '1'),
      row('NetworkConfiguration', 'OcppInterface', 'Wireless0', '2'),
    ];
    expect(activeNetworkLink(rows)).toBe('wired');
  });

  it('tells nothing for Any, a missing slot or an OCPP 1.6 station', () => {
    expect(
      activeNetworkLink([
        row('OCPPCommCtrlr', 'NetworkConfigurationPriority', '1'),
        row('NetworkConfiguration', 'OcppInterface', 'Any', '1'),
      ]),
    ).toBeNull();
    expect(
      activeNetworkLink([row('NetworkConfiguration', 'OcppInterface', 'Wired0', '1')]),
    ).toBeNull();
    expect(activeNetworkLink([])).toBeNull();
  });
});

describe('readLayoutStationLinks', () => {
  it('maps the reported dBm to bars and keeps the network type as reported', async () => {
    settingsMock.mockResolvedValue({ on: true, stationSignalEnabled: true });
    providersMock.mockResolvedValue([{ id: 'hologram' }]);
    summariesMock.mockResolvedValue(
      new Map([
        ['a', { networkType: 'LTE-M', signalDbm: -64 }],
        ['b', { networkType: null, signalDbm: -112 }],
        ['c', { networkType: '5G', signalDbm: null }],
      ]),
    );
    const links = await readLayoutStationLinks(['a', 'b', 'c'], log);
    expect(summariesMock).toHaveBeenCalledWith(['a', 'b', 'c'], {
      signalEnabled: true,
      enabledProviders: ['hologram'],
    });
    expect(links.get('a')).toEqual({ networkType: 'LTE-M', signal: { bars: 4, dbm: -64 } });
    expect(links.get('b')).toEqual({ networkType: null, signal: { bars: 0, dbm: -112 } });
    expect(links.get('c')).toEqual({ networkType: '5G', signal: null });
  });

  it('reads nothing while the SIM features are off or no station is cellular', async () => {
    settingsMock.mockResolvedValue({ on: false, stationSignalEnabled: false });
    expect((await readLayoutStationLinks(['a'], log)).size).toBe(0);
    expect((await readLayoutStationLinks([], log)).size).toBe(0);
    expect(summariesMock).not.toHaveBeenCalled();
  });

  it('logs a read failure and shows no signal', async () => {
    settingsMock.mockRejectedValue(new Error('no key'));
    expect((await readLayoutStationLinks(['a'], log)).size).toBe(0);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
