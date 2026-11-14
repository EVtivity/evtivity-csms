// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  render: vi.fn(),
  tariff: vi.fn(),
  rows: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(mocks.rows()),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(mocks.rows()).then(resolve, reject),
  };
  return {
    // AC and DC tariffs: the charging kind readers (tested in the database package).
    loadStationEvseKinds: vi.fn(() => Promise.resolve(new Map())),
    startChargingKinds: vi.fn(() => Promise.resolve([null])),
    loadEvseChargingKind: vi.fn(() => Promise.resolve(null)),
    resolvableKind: vi.fn(() => null),
    db: { select: () => chain },
    client: {},
    users: { id: 'id', language: 'language' },
    pricingGroupStations: { stationId: 'station_id', pricingGroupId: 'pricing_group_id' },
    getCompanyName: () => Promise.resolve('Acme Charging'),
    getCompanySupportPhone: () => Promise.resolve('+1 555 0100'),
    getCompanyCurrency: () => Promise.resolve('USD'),
    getCompanyPriceDisplay: () => Promise.resolve('net'),
    getCompanyTaxBasis: () => Promise.resolve('net'),
    getStationMessageBrandLine: () => Promise.resolve(''),
    getStationMessagePricingFormat: () => Promise.resolve('compact'),
    isStationMessageEnabled: mocks.enabled,
    resolveStationDisplayPricing: mocks.tariff,
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, renderStationMessage: mocks.render };
});

import {
  resolveLayoutScreenMessages,
  screenTemplateState,
  stationReceivesState,
  viewerScreenLanguage,
  type ScreenStation,
} from '../lib/site-layout-screen-message.js';

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function station(over: Partial<ScreenStation> = {}): ScreenStation {
  return {
    id: 'sta_1',
    stationOcppId: 'CS-1',
    ocppProtocol: 'ocpp2.1',
    status: 'available',
    connectorStatuses: ['available'],
    hasActiveSession: false,
    displayMessage: null,
    energyDeliveredWh: null,
    session: null,
    reservationEndsAt: null,
    ...over,
  };
}

beforeEach(() => {
  mocks.enabled.mockResolvedValue(true);
  mocks.render.mockImplementation((state: string, ctx: { stationOcppId: string }) =>
    Promise.resolve(`${state} ${ctx.stationOcppId}`),
  );
  mocks.tariff.mockResolvedValue({ tariff: null, byKind: null });
  mocks.rows.mockReturnValue([]);
});

describe('screenTemplateState', () => {
  it('puts a station fault or unavailability first', () => {
    expect(
      screenTemplateState({
        status: 'faulted',
        connectorStatuses: ['charging'],
        hasActiveSession: true,
      }),
    ).toBe('faulted');
    expect(
      screenTemplateState({
        status: 'unavailable',
        connectorStatuses: ['available'],
        hasActiveSession: false,
      }),
    ).toBe('unavailable');
  });

  it('shows the transaction screens of a session in progress', () => {
    const base = { status: 'charging', hasActiveSession: true };
    expect(screenTemplateState({ ...base, connectorStatuses: ['charging'] })).toBe('charging');
    expect(screenTemplateState({ ...base, connectorStatuses: ['suspended_ev'] })).toBe('suspended');
    expect(screenTemplateState({ ...base, connectorStatuses: ['suspended_evse'] })).toBe(
      'suspended',
    );
    expect(screenTemplateState({ ...base, connectorStatuses: ['discharging'] })).toBe(
      'discharging',
    );
    // A session that is not charging falls back to the idle available screen.
    expect(screenTemplateState({ ...base, connectorStatuses: ['ev_connected'] })).toBe('available');
  });

  it('shows reserved, then occupied without a session, else available', () => {
    expect(
      screenTemplateState({
        status: 'reserved',
        connectorStatuses: ['reserved', 'occupied'],
        hasActiveSession: false,
      }),
    ).toBe('reserved');
    expect(
      screenTemplateState({
        status: 'charging',
        connectorStatuses: ['preparing'],
        hasActiveSession: false,
      }),
    ).toBe('occupied');
    expect(
      screenTemplateState({ status: 'unknown', connectorStatuses: [], hasActiveSession: false }),
    ).toBe('available');
  });
});

describe('stationReceivesState', () => {
  it('gives OCPP 2.x every screen, 1.6 only the idle screen, an unknown protocol none', () => {
    expect(stationReceivesState('ocpp2.1', 'charging')).toBe(true);
    expect(stationReceivesState('ocpp2.0.1', 'faulted')).toBe(true);
    expect(stationReceivesState('ocpp1.6', 'available')).toBe(true);
    expect(stationReceivesState('ocpp1.6', 'reserved')).toBe(true);
    expect(stationReceivesState('ocpp1.6', 'charging')).toBe(false);
    expect(stationReceivesState('ocpp1.6', 'faulted')).toBe(false);
    expect(stationReceivesState(null, 'available')).toBe(false);
  });
});

describe('viewerScreenLanguage', () => {
  it('uses the user language, else English', async () => {
    mocks.rows.mockReturnValueOnce([{ language: 'de' }]);
    await expect(viewerScreenLanguage('usr_1')).resolves.toBe('de');
    mocks.rows.mockReturnValueOnce([{ language: 'fr' }]);
    await expect(viewerScreenLanguage('usr_1')).resolves.toBe('en');
    mocks.rows.mockReturnValueOnce([]);
    await expect(viewerScreenLanguage('usr_1')).resolves.toBe('en');
  });
});

describe('resolveLayoutScreenMessages', () => {
  const opts = { language: 'en' as const, timezone: 'America/New_York', log };

  it('shows the active display message first', async () => {
    const result = await resolveLayoutScreenMessages(
      [station({ displayMessage: 'Free charging today' })],
      opts,
    );
    expect(result.get('sta_1')).toEqual({ text: 'Free charging today', source: 'display_message' });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('renders the template of the state in the viewer language while station messages are on', async () => {
    const result = await resolveLayoutScreenMessages(
      [station({ status: 'faulted', connectorStatuses: ['faulted'] })],
      { ...opts, language: 'ko' },
    );
    expect(result.get('sta_1')).toEqual({
      text: 'faulted CS-1',
      source: 'station_message_template',
    });
    expect(mocks.render).toHaveBeenCalledWith(
      'faulted',
      expect.objectContaining({ companyName: 'Acme Charging', supportPhone: '+1 555 0100' }),
      'ko',
    );
  });

  it('shows the welcome in the viewer language while station messages are off', async () => {
    mocks.enabled.mockResolvedValue(false);
    const result = await resolveLayoutScreenMessages([station()], { ...opts, language: 'de' });
    expect(result.get('sta_1')).toEqual({
      text: 'Willkommen bei Acme Charging',
      source: 'default_welcome',
    });
  });

  it('shows the welcome for a screen the station never gets, an empty template or a failed render', async () => {
    mocks.render.mockImplementation((_state: string, ctx: { stationOcppId: string }) =>
      ctx.stationOcppId === 'CS-3'
        ? Promise.resolve('  ')
        : Promise.reject(new Error('template not allowed')),
    );
    const result = await resolveLayoutScreenMessages(
      [
        station({
          id: 'a',
          stationOcppId: 'CS-1',
          ocppProtocol: 'ocpp1.6',
          status: 'charging',
          connectorStatuses: ['charging'],
          hasActiveSession: true,
        }),
        station({ id: 'b', stationOcppId: 'CS-2' }),
        station({ id: 'c', stationOcppId: 'CS-3' }),
      ],
      opts,
    );
    for (const id of ['a', 'b', 'c']) {
      expect(result.get(id)).toEqual({
        text: 'Welcome to Acme Charging',
        source: 'default_welcome',
      });
    }
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CS-2', state: 'available' }),
      expect.any(String),
    );
  });

  it('resolves the tariff once per station pricing group and renders a shared context once', async () => {
    mocks.rows.mockReturnValue([{ stationId: 'c', groupId: 'pgr_x' }]);
    mocks.render.mockResolvedValue('Unavailable');
    const result = await resolveLayoutScreenMessages(
      [
        station({ id: 'a', stationOcppId: 'CS-1', status: 'unavailable' }),
        station({ id: 'b', stationOcppId: 'CS-1', status: 'unavailable' }),
        station({ id: 'c', stationOcppId: 'CS-3' }),
      ],
      opts,
    );
    // Stations a and b share the site's pricing; c has its own group.
    expect(mocks.tariff).toHaveBeenCalledTimes(2);
    // a and b have the same state and context, so one render serves both.
    expect(mocks.render.mock.calls.filter((c) => c[0] === 'unavailable')).toHaveLength(1);
    expect(result.get('a')?.text).toBe('Unavailable');
    expect(result.get('b')?.text).toBe('Unavailable');
  });

  it('shows AC and DC prices on the idle screen of a station whose kinds differ', async () => {
    const tariff = (pricePerKwh: string) => ({
      pricePerKwh,
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      taxRate: '0',
    });
    mocks.tariff.mockResolvedValue({
      tariff: tariff('0.30'),
      byKind: { ac: tariff('0.30'), dc: tariff('0.55') },
    });
    await resolveLayoutScreenMessages([station()], opts);
    const ctx = mocks.render.mock.calls[0]?.[1] as {
      pricingDisplay?: string;
      energyPrice?: string;
    };
    expect(ctx.pricingDisplay).toMatch(/^AC: .*\| DC: /);
    expect(ctx.energyPrice).toBe('AC $0.30 / DC $0.55');
  });

  it('fills the charging values from the session the viewer may read', async () => {
    await resolveLayoutScreenMessages(
      [
        station({
          status: 'charging',
          connectorStatuses: ['charging'],
          hasActiveSession: true,
          energyDeliveredWh: 12_400,
          session: {
            startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
            currentCostCents: 450,
            currency: 'USD',
          },
        }),
      ],
      opts,
    );
    expect(mocks.render).toHaveBeenCalledWith(
      'charging',
      expect.objectContaining({
        energyKwh: '12.4',
        costFormatted: '$4.50',
        elapsedFormatted: expect.stringContaining('5') as unknown,
      }),
      'en',
    );
    expect(mocks.tariff).not.toHaveBeenCalled();
  });

  it('shows the reservation end in the site time zone', async () => {
    await resolveLayoutScreenMessages(
      [
        station({
          status: 'reserved',
          connectorStatuses: ['reserved'],
          reservationEndsAt: '2026-11-02T20:30:00.000Z',
        }),
      ],
      opts,
    );
    expect(mocks.render).toHaveBeenCalledWith(
      'reserved',
      expect.objectContaining({ reservationExpiresAt: '3:30 PM' }),
      'en',
    );
  });
});
