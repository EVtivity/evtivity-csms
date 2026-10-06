// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  isStartable,
  isEvseSelectable,
  connectorStatusVariant,
  connectorStatusClassName,
  type SelectableEvse,
} from '../connector-status';

function evse(status: string | null, reservationDriverId: string | null = null): SelectableEvse {
  return { connectors: [{ status }], reservationDriverId };
}

const chargeOnline = {
  mode: 'charge' as const,
  isOnline: true,
  maintenanceActive: false,
  stationUnavailable: false,
  currentDriverId: 'drv_self',
};

describe('isStartable', () => {
  it('accepts the startable OCPP statuses', () => {
    for (const s of ['available', 'occupied', 'preparing', 'ev_connected', 'finishing']) {
      expect(isStartable(s)).toBe(true);
    }
  });

  it('rejects non-startable statuses and nullish', () => {
    for (const s of ['charging', 'reserved', 'faulted', 'unavailable', 'idle']) {
      expect(isStartable(s)).toBe(false);
    }
    expect(isStartable(null)).toBe(false);
    expect(isStartable(undefined)).toBe(false);
  });
});

describe('isEvseSelectable (charge mode)', () => {
  it('selects an available, unreserved connector', () => {
    expect(isEvseSelectable(evse('available'), chargeOnline)).toBe(true);
  });

  it('rejects a non-startable connector', () => {
    expect(isEvseSelectable(evse('faulted'), chargeOnline)).toBe(false);
  });

  it('rejects when the station is offline', () => {
    expect(isEvseSelectable(evse('available'), { ...chargeOnline, isOnline: false })).toBe(false);
  });

  it('rejects when the whole station is unavailable', () => {
    expect(isEvseSelectable(evse('available'), { ...chargeOnline, stationUnavailable: true })).toBe(
      false,
    );
    expect(
      isEvseSelectable(evse('available'), {
        ...chargeOnline,
        mode: 'reserve',
        stationUnavailable: true,
      }),
    ).toBe(false);
  });

  it('rejects when maintenance is active', () => {
    expect(isEvseSelectable(evse('available'), { ...chargeOnline, maintenanceActive: true })).toBe(
      false,
    );
  });

  it('rejects a connector reserved by another driver even when startable', () => {
    expect(isEvseSelectable(evse('preparing', 'drv_other'), chargeOnline)).toBe(false);
  });

  it('allows a connector reserved for the current driver', () => {
    expect(isEvseSelectable(evse('preparing', 'drv_self'), chargeOnline)).toBe(true);
  });
});

describe('isEvseSelectable (reserve mode)', () => {
  const reserveOnline = { ...chargeOnline, mode: 'reserve' as const };

  it('selects an online connector with no existing reservation, regardless of status', () => {
    expect(isEvseSelectable(evse('charging'), reserveOnline)).toBe(true);
  });

  it('rejects a connector that already has any reservation', () => {
    expect(isEvseSelectable(evse('available', 'drv_other'), reserveOnline)).toBe(false);
    expect(isEvseSelectable(evse('available', 'drv_self'), reserveOnline)).toBe(false);
  });

  it('rejects when offline or under maintenance', () => {
    expect(isEvseSelectable(evse('available'), { ...reserveOnline, isOnline: false })).toBe(false);
    expect(isEvseSelectable(evse('available'), { ...reserveOnline, maintenanceActive: true })).toBe(
      false,
    );
  });
});

describe('connectorStatusClassName', () => {
  it.each([
    ['available', 'bg-green-500'],
    ['finishing', 'bg-violet-500'],
    ['occupied', 'bg-blue-500'],
    ['charging', 'bg-blue-500'],
    ['discharging', 'bg-blue-500'],
    ['preparing', 'bg-cyan-500'],
    ['ev_connected', 'bg-cyan-500'],
    ['reserved', 'bg-orange-500'],
    ['suspended_ev', 'bg-yellow-500'],
    ['suspended_evse', 'bg-yellow-500'],
    ['idle', 'bg-yellow-500'],
    ['faulted', 'bg-red-500'],
    ['unavailable', 'bg-red-500'],
    ['something_new', 'bg-red-500'],
  ])('%s uses %s', (status, cls) => {
    expect(connectorStatusClassName(status).split(' ')[0]).toBe(cls);
  });

  it('always uses the secondary badge variant', () => {
    expect(connectorStatusVariant()).toBe('secondary');
  });
});
