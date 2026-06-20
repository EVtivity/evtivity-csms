// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

let partnerRows: unknown[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from']) chain[m] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(partnerRows));
  return chain;
}

const isRoamingEnabled = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  ocpiPartners: { id: 'ocpiPartners.id', status: 'ocpiPartners.status' },
  isRoamingEnabled: () => isRoamingEnabled(),
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const publish = vi.fn(() => Promise.resolve());
vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish }),
}));

import { ocpiLocationSyncHandler } from '../../handlers/ocpi-location-sync.js';

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

describe('ocpiLocationSyncHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    partnerRows = [];
  });

  it('does nothing when roaming is disabled', async () => {
    isRoamingEnabled.mockResolvedValue(false);
    partnerRows = [{ id: 'opr_1' }];

    await ocpiLocationSyncHandler(log);

    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes a locations sync per connected partner when roaming is enabled', async () => {
    isRoamingEnabled.mockResolvedValue(true);
    partnerRows = [{ id: 'opr_1' }, { id: 'opr_2' }];

    await ocpiLocationSyncHandler(log);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(
      'ocpi_sync',
      JSON.stringify({ partnerId: 'opr_1', module: 'locations' }),
    );
    expect(publish).toHaveBeenCalledWith(
      'ocpi_sync',
      JSON.stringify({ partnerId: 'opr_2', module: 'locations' }),
    );
  });

  it('no-ops when there are no connected partners', async () => {
    isRoamingEnabled.mockResolvedValue(true);
    partnerRows = [];

    await ocpiLocationSyncHandler(log);

    expect(publish).not.toHaveBeenCalled();
  });
});
