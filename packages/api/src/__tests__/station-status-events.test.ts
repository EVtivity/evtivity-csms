// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  publish: vi.fn(async (_channel: string, _payload: string) => {}),
  isRoamingEnabled: vi.fn(async () => true),
}));

vi.mock('@evtivity/database', () => ({ isRoamingEnabled: h.isRoamingEnabled }));
vi.mock('../lib/pubsub.js', () => ({ getPubSub: () => ({ publish: h.publish }) }));

import { publishStationStatusChanged } from '../lib/station-status-events.js';

function logger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('publishStationStatusChanged', () => {
  beforeEach(() => {
    h.publish.mockReset();
    h.publish.mockResolvedValue(undefined);
    h.isRoamingEnabled.mockReset();
    h.isRoamingEnabled.mockResolvedValue(true);
  });

  it('publishes station.status and an OCPI location push', async () => {
    await publishStationStatusChanged({ id: 'sta_1', siteId: 'sit_1' });
    expect(h.publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({ eventType: 'station.status', stationId: 'sta_1', siteId: 'sit_1' }),
    );
    expect(h.publish).toHaveBeenCalledWith(
      'ocpi_push',
      JSON.stringify({ type: 'location', siteId: 'sit_1' }),
    );
  });

  it('skips the OCPI push when roaming is disabled', async () => {
    h.isRoamingEnabled.mockResolvedValue(false);
    await publishStationStatusChanged({ id: 'sta_1', siteId: 'sit_1' });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]?.[0]).toBe('csms_events');
  });

  it('skips the OCPI push for a station without a site', async () => {
    await publishStationStatusChanged({ id: 'sta_1', siteId: null });
    expect(h.isRoamingEnabled).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('logs and continues when a publish fails', async () => {
    h.publish.mockRejectedValue(new Error('redis down'));
    const log = logger();
    await publishStationStatusChanged({ id: 'sta_1', siteId: 'sit_1' }, log as never);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
