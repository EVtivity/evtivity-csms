// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderStationMessage,
  clearStationMessageCache,
  type StationMessageContext,
  type StationMessageState,
} from '../station-message.js';

vi.mock('@evtivity/database', () => {
  const whereFn = vi.fn();
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return {
    db: { select: selectFn },
    stationMessageTemplates: {
      body: 'body_col',
      updatedAt: 'updated_at_col',
      state: 'state_col',
    },
    __mocks: { selectFn, fromFn, whereFn },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
}));

async function setBody(body: string, updatedAt: Date = new Date(2026, 0, 1)): Promise<void> {
  const mod = (await import('@evtivity/database')) as unknown as {
    __mocks: { whereFn: ReturnType<typeof vi.fn> };
  };
  mod.__mocks.whereFn.mockResolvedValue([{ body, updatedAt }]);
}

const baseContext: StationMessageContext = {
  companyName: 'EVtivity',
  stationOcppId: 'CS-1234',
  pricingDisplay: '$0.30/kWh + $0.02/min',
  energyKwh: '12.4',
  powerKw: '22.0',
  costFormatted: '$3.42',
  elapsedFormatted: '12m',
  idleFeeRate: '$0.10/min',
  supportPhone: '+1-555-0100',
  driverFirstName: 'Alex',
  reservationExpiresAt: '3:45 PM',
};

const STATE_BODIES: Record<StationMessageState, string> = {
  available: '{{companyName}}\n{{stationOcppId}}\n{{pricingDisplay}}\nPlug in to start',
  occupied: '{{stationOcppId}}\nTap card or open app\nto start charging',
  reserved:
    'Reserved\n{{#if driverFirstName}}for {{driverFirstName}}{{/if}}\nuntil {{reservationExpiresAt}}',
  charging: 'Charging\n{{energyKwh}} kWh / {{powerKw}} kW\n{{costFormatted}}\n{{elapsedFormatted}}',
  suspended: 'Charging paused\n{{#if idleFeeRate}}Idle fee {{idleFeeRate}} after grace{{/if}}',
  discharging: 'Discharging to grid\n{{energyKwh}} kWh sent\n{{costFormatted}}',
  faulted: 'Station fault\nContact support\n{{supportPhone}}',
  unavailable: 'Temporarily unavailable\n{{companyName}}',
  payment_failed:
    'Payment declined.\nUpdate your card in the app and try again.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}',
  payment_required: 'Add a payment method\nin the app to start charging.\n{{companyName}}',
  guest_unauthorized: 'Guest payment not authorized.\nScan the QR code\nto restart checkout.',
  unauthorized: 'Tap your RFID card\nor scan the QR code\nto authorize charging.',
};

describe('renderStationMessage', () => {
  beforeEach(() => {
    clearStationMessageCache();
    vi.clearAllMocks();
  });

  describe('default templates render with all variables set', () => {
    it('renders the available template', async () => {
      await setBody(STATE_BODIES.available);
      const result = await renderStationMessage('available', baseContext);
      expect(result).toBe('EVtivity\nCS-1234\n$0.30/kWh + $0.02/min\nPlug in to start');
    });

    it('renders the occupied template', async () => {
      await setBody(STATE_BODIES.occupied);
      const result = await renderStationMessage('occupied', baseContext);
      expect(result).toBe('CS-1234\nTap card or open app\nto start charging');
    });

    it('renders the reserved template', async () => {
      await setBody(STATE_BODIES.reserved);
      const result = await renderStationMessage('reserved', baseContext);
      expect(result).toBe('Reserved\nfor Alex\nuntil 3:45 PM');
    });

    it('renders the charging template', async () => {
      await setBody(STATE_BODIES.charging);
      const result = await renderStationMessage('charging', baseContext);
      expect(result).toBe('Charging\n12.4 kWh / 22.0 kW\n$3.42\n12m');
    });

    it('renders the suspended template', async () => {
      await setBody(STATE_BODIES.suspended);
      const result = await renderStationMessage('suspended', baseContext);
      expect(result).toBe('Charging paused\nIdle fee $0.10/min after grace');
    });

    it('renders the discharging template', async () => {
      await setBody(STATE_BODIES.discharging);
      const result = await renderStationMessage('discharging', baseContext);
      expect(result).toBe('Discharging to grid\n12.4 kWh sent\n$3.42');
    });

    it('renders the faulted template', async () => {
      await setBody(STATE_BODIES.faulted);
      const result = await renderStationMessage('faulted', baseContext);
      expect(result).toBe('Station fault\nContact support\n+1-555-0100');
    });

    it('renders the unavailable template', async () => {
      await setBody(STATE_BODIES.unavailable);
      const result = await renderStationMessage('unavailable', baseContext);
      expect(result).toBe('Temporarily unavailable\nEVtivity');
    });
  });

  describe('missing-variable fallback', () => {
    it('substitutes empty string when an optional variable is missing', async () => {
      await setBody(STATE_BODIES.charging);
      const minimalContext: StationMessageContext = {
        companyName: 'EVtivity',
        stationOcppId: 'CS-1234',
      };
      const result = await renderStationMessage('charging', minimalContext);
      expect(result).toBe('Charging\n kWh /  kW\n\n');
    });

    it('omits if-blocks when the gating variable is empty', async () => {
      await setBody(STATE_BODIES.reserved);
      const contextWithoutDriver: StationMessageContext = {
        companyName: 'EVtivity',
        stationOcppId: 'CS-1234',
        reservationExpiresAt: '3:45 PM',
      };
      const result = await renderStationMessage('reserved', contextWithoutDriver);
      expect(result).toBe('Reserved\n\nuntil 3:45 PM');
    });

    it('returns empty string when the template row does not exist', async () => {
      const mod = (await import('@evtivity/database')) as unknown as {
        __mocks: { whereFn: ReturnType<typeof vi.fn> };
      };
      mod.__mocks.whereFn.mockResolvedValue([]);
      const result = await renderStationMessage('available', baseContext);
      expect(result).toBe('');
    });
  });

  describe('compiled template cache', () => {
    it('caches the row and compiled template across repeated calls for the same state', async () => {
      const mod = (await import('@evtivity/database')) as unknown as {
        __mocks: {
          selectFn: ReturnType<typeof vi.fn>;
          whereFn: ReturnType<typeof vi.fn>;
        };
      };
      const stableUpdatedAt = new Date(2026, 0, 1);
      mod.__mocks.whereFn.mockResolvedValue([
        { body: STATE_BODIES.available, updatedAt: stableUpdatedAt },
      ]);

      const first = await renderStationMessage('available', baseContext);
      const second = await renderStationMessage('available', baseContext);
      const third = await renderStationMessage('available', baseContext);

      expect(first).toBe(second);
      expect(second).toBe(third);
      expect(first).toBe('EVtivity\nCS-1234\n$0.30/kWh + $0.02/min\nPlug in to start');
      expect(mod.__mocks.selectFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after TTL expiry but reuses the compiled template when updatedAt is unchanged', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
      try {
        const mod = (await import('@evtivity/database')) as unknown as {
          __mocks: {
            selectFn: ReturnType<typeof vi.fn>;
            whereFn: ReturnType<typeof vi.fn>;
          };
        };
        const stableUpdatedAt = new Date(2026, 0, 1);
        mod.__mocks.whereFn.mockResolvedValue([
          { body: STATE_BODIES.available, updatedAt: stableUpdatedAt },
        ]);

        const first = await renderStationMessage('available', baseContext);

        // Advance past the 60s cache TTL so the cached entry is expired, but the
        // DB still returns the same updatedAt -> same cacheKey. This exercises
        // the "expired-but-key-matches" branch: refresh expiresAt, reuse the
        // already-compiled template (no recompile).
        vi.advanceTimersByTime(61_000);

        const second = await renderStationMessage('available', baseContext);

        expect(second).toBe(first);
        expect(second).toBe('EVtivity\nCS-1234\n$0.30/kWh + $0.02/min\nPlug in to start');
        // The row was re-fetched (cache expired) so select ran twice.
        expect(mod.__mocks.selectFn).toHaveBeenCalledTimes(2);

        // The refreshed cache entry is now valid again: a third call within the
        // new TTL window hits the in-memory cache and does not re-fetch.
        const third = await renderStationMessage('available', baseContext);
        expect(third).toBe(first);
        expect(mod.__mocks.selectFn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
