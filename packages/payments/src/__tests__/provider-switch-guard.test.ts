// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessWatchStore } from '@evtivity/database';

const { releaseUpgradePending } = vi.hoisted(() => ({ releaseUpgradePending: vi.fn() }));

vi.mock('@evtivity/database', () => ({ releaseUpgradePending }));

import {
  assertProviderSelectable,
  PaymentProviderUpgradePendingError,
  providerUpgradePending,
} from '../provider-switch-guard.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const store: ProcessWatchStore = { get: vi.fn(), set: vi.fn() };

beforeEach(() => {
  releaseUpgradePending.mockReset();
});

describe('assertProviderSelectable', () => {
  it('never runs the check for providers that are not guarded', async () => {
    for (const id of ['stripe', 'simulated', 'none', 'acme']) {
      await expect(assertProviderSelectable(id, store, NOW)).resolves.toBeUndefined();
    }
    expect(releaseUpgradePending).not.toHaveBeenCalled();
  });

  it('asks the release guard for no process before v0.1.38 and allows adyen when it passes', async () => {
    releaseUpgradePending.mockResolvedValue(null);
    await expect(assertProviderSelectable('adyen', store, NOW)).resolves.toBeUndefined();
    expect(releaseUpgradePending).toHaveBeenCalledWith(null, store, NOW);
  });

  it('refuses adyen with the details while the release guard refuses', async () => {
    releaseUpgradePending.mockResolvedValue({
      oldConnections: 3,
      hosts: ['10.0.0.7'],
      lastOldSeenAt: '2026-10-04T11:58:00.000Z',
      watchCheckedAt: '2026-10-04T11:59:30.000Z',
    });
    const err = await assertProviderSelectable('adyen', store, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderUpgradePendingError);
    expect((err as PaymentProviderUpgradePendingError).providerId).toBe('adyen');
    expect((err as PaymentProviderUpgradePendingError).details).toEqual({
      legacyConnections: 3,
      hosts: ['10.0.0.7'],
      lastLegacySeenAt: '2026-10-04T11:58:00.000Z',
      watchCheckedAt: '2026-10-04T11:59:30.000Z',
    });
  });

  it('throws a check error instead of allowing the switch', async () => {
    releaseUpgradePending.mockRejectedValue(new Error('connection refused'));
    await expect(assertProviderSelectable('adyen', store, NOW)).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('providerUpgradePending', () => {
  it('returns null when the switch is allowed', async () => {
    releaseUpgradePending.mockResolvedValue(null);
    await expect(providerUpgradePending('adyen', store, NOW)).resolves.toBeNull();
  });
});
