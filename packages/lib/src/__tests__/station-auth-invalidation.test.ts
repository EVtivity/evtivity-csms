// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { PubSubClient } from '../pubsub.js';
import {
  CACHE_INVALIDATE_CHANNEL,
  parseStationAuthInvalidation,
  publishStationAuthInvalidation,
  stationAuthInvalidationPayload,
} from '../station-auth-invalidation.js';

function pubsubWith(publish: PubSubClient['publish']): PubSubClient {
  return { publish, subscribe: vi.fn(), close: vi.fn() };
}

describe('station auth invalidation', () => {
  it('round-trips the station database id', () => {
    const msg = JSON.parse(stationAuthInvalidationPayload('sta_1')) as unknown;
    expect(parseStationAuthInvalidation(msg)).toBe('sta_1');
  });

  it('ignores other cache messages and malformed ones', () => {
    expect(parseStationAuthInvalidation({ cache: 'ocppEventSettings' })).toBeNull();
    expect(parseStationAuthInvalidation({ kind: 'station_auth' })).toBeNull();
    expect(parseStationAuthInvalidation({ kind: 'station_auth', stationId: '' })).toBeNull();
    expect(parseStationAuthInvalidation({ kind: 'station_auth', stationId: 7 })).toBeNull();
    expect(parseStationAuthInvalidation(null)).toBeNull();
    expect(parseStationAuthInvalidation('station_auth')).toBeNull();
  });

  it('publishes on the cache invalidation channel', async () => {
    const publish = vi.fn(() => Promise.resolve());
    await publishStationAuthInvalidation(pubsubWith(publish), 'sta_1', { warn: vi.fn() });

    expect(publish).toHaveBeenCalledWith(
      CACHE_INVALIDATE_CHANNEL,
      stationAuthInvalidationPayload('sta_1'),
    );
  });

  it('warns instead of throwing when the publish fails', async () => {
    const warn = vi.fn();
    const publish = vi.fn(() => Promise.reject(new Error('redis down')));

    await expect(
      publishStationAuthInvalidation(pubsubWith(publish), 'sta_1', { warn }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationDbId: 'sta_1' }),
      'Failed to publish station auth cache invalidation',
    );
  });
});
