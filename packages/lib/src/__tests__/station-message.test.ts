// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderStationMessage,
  clearStationMessageCache,
  buildStationPriceContext,
  stationTaxNoteContext,
  formatStationIdleFeeRate,
  formatStationQuantity,
  formatStationTime,
  formatStationElapsed,
  type StationMessageContext,
  type StationMessageState,
} from '../station-message.js';

vi.mock('@evtivity/database', () => {
  const whereFn = vi.fn();
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const getStationMessageLanguage = vi.fn().mockResolvedValue('en');
  return {
    db: { select: selectFn },
    stationMessageTemplates: {
      body: 'body_col',
      updatedAt: 'updated_at_col',
      state: 'state_col',
      language: 'language_col',
    },
    getStationMessageLanguage,
    __mocks: { selectFn, fromFn, whereFn, getStationMessageLanguage },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
}));

interface DbMocks {
  selectFn: ReturnType<typeof vi.fn>;
  whereFn: ReturnType<typeof vi.fn>;
  getStationMessageLanguage: ReturnType<typeof vi.fn>;
}

async function dbMocks(): Promise<DbMocks> {
  const mod = (await import('@evtivity/database')) as unknown as { __mocks: DbMocks };
  return mod.__mocks;
}

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
  charging:
    'Charging\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
  suspended: 'Charging paused\n{{#if idleFeeRate}}Idle fee {{idleFeeRate}} after grace{{/if}}',
  discharging: 'Discharging to grid\n{{energyKwh}} kWh sent\n{{costFormatted}}',
  faulted: 'Station fault\nContact support\n{{supportPhone}}',
  unavailable: 'Temporarily unavailable\n{{companyName}}',
  payment_failed:
    'Payment declined.\nUpdate your card in the app and try again.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}',
  payment_required: 'Add a payment method\nin the app to start charging.\n{{companyName}}',
  guest_unauthorized: 'Guest payment not authorized.\nScan the QR code\nto restart checkout.',
  unauthorized: 'Tap your RFID card\nor scan the QR code\nto authorize charging.',
  prepaid_exhausted:
    'Prepaid credit used up.\nCharging stopped.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}',
  account_credit_limit:
    'Fleet credit limit reached.\nCharging stopped.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}',
};

describe('renderStationMessage', () => {
  beforeEach(async () => {
    clearStationMessageCache();
    vi.clearAllMocks();
    (await dbMocks()).getStationMessageLanguage.mockResolvedValue('en');
  });

  describe('display language', () => {
    it('loads the template row for the state and the given language', async () => {
      const mocks = await dbMocks();
      await setBody('{{companyName}} DE');
      const result = await renderStationMessage('available', baseContext, 'de');
      expect(result).toBe('EVtivity DE');
      expect(mocks.whereFn).toHaveBeenCalledWith({
        type: 'and',
        conditions: [
          { type: 'eq', a: 'state_col', b: 'available' },
          { type: 'eq', a: 'language_col', b: 'de' },
        ],
      });
      expect(mocks.getStationMessageLanguage).not.toHaveBeenCalled();
    });

    it('uses the stationMessage.language setting without a language', async () => {
      const mocks = await dbMocks();
      mocks.getStationMessageLanguage.mockResolvedValue('ko');
      await setBody('KO');
      await renderStationMessage('unauthorized', baseContext);
      expect(mocks.whereFn).toHaveBeenCalledWith({
        type: 'and',
        conditions: [
          { type: 'eq', a: 'state_col', b: 'unauthorized' },
          { type: 'eq', a: 'language_col', b: 'ko' },
        ],
      });
    });

    it('falls back to English when the setting holds an unsupported language', async () => {
      const mocks = await dbMocks();
      mocks.getStationMessageLanguage.mockResolvedValue('fr');
      await setBody('EN');
      await renderStationMessage('unauthorized', baseContext);
      expect(mocks.whereFn).toHaveBeenCalledWith({
        type: 'and',
        conditions: [
          { type: 'eq', a: 'state_col', b: 'unauthorized' },
          { type: 'eq', a: 'language_col', b: 'en' },
        ],
      });
    });

    it('caches compiled templates per language', async () => {
      const mocks = await dbMocks();
      await setBody('English');
      expect(await renderStationMessage('faulted', baseContext, 'en')).toBe('English');
      await setBody('Deutsch');
      expect(await renderStationMessage('faulted', baseContext, 'de')).toBe('Deutsch');
      expect(await renderStationMessage('faulted', baseContext, 'en')).toBe('English');
      expect(mocks.selectFn).toHaveBeenCalledTimes(2);
    });

    it('renders the tax note booleans and rates', async () => {
      await setBody(
        '{{#if taxRatePercent}}{{#if pricesIncludeTax}}incl.{{else}}excl.{{/if}} {{taxRatePercent}}% tax{{/if}}',
      );
      expect(
        await renderStationMessage(
          'available',
          { ...baseContext, taxRatePercent: '19', pricesIncludeTax: true },
          'en',
        ),
      ).toBe('incl. 19% tax');
      expect(
        await renderStationMessage(
          'available',
          { ...baseContext, taxRatePercent: '19', pricesIncludeTax: false },
          'en',
        ),
      ).toBe('excl. 19% tax');
      expect(await renderStationMessage('available', baseContext, 'en')).toBe('');
    });

    it('exposes the single price variables', async () => {
      await setBody('{{energyPrice}}|{{timePrice}}|{{sessionFee}}|{{idleFee}}');
      const result = await renderStationMessage(
        'available',
        {
          ...baseContext,
          energyPrice: '€0.357',
          timePrice: '€0.024',
          sessionFee: '€1.19',
          idleFee: '€0.119',
        },
        'en',
      );
      expect(result).toBe('€0.357|€0.024|€1.19|€0.119');
    });
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

    it('leaves the power out of the charging template when the station reports none', async () => {
      await setBody(STATE_BODIES.charging);
      const result = await renderStationMessage('charging', { ...baseContext, powerKw: '' });
      expect(result).toBe('Charging\n12.4 kWh\n$3.42\n12m');
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
      expect(result).toBe('Charging\n kWh\n\n');
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

    it('renders the brand line, or the company name when it is empty', async () => {
      await setBody('{{brandLine}}\n{{stationOcppId}}');
      expect(await renderStationMessage('available', { ...baseContext, brandLine: 'ACME' })).toBe(
        'ACME\nCS-1234',
      );
      expect(await renderStationMessage('available', { ...baseContext, brandLine: '  ' })).toBe(
        'EVtivity\nCS-1234',
      );
      expect(await renderStationMessage('available', baseContext)).toBe('EVtivity\nCS-1234');
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

const TARIFF = {
  pricePerKwh: '0.30',
  pricePerMinute: '0.02',
  pricePerSession: '1.00',
  idleFeePricePerMinute: '0.10',
  taxRate: '0.19',
};

describe('buildStationPriceContext', () => {
  it('shows net prices with an excl. tax note for net display', () => {
    const ctx = buildStationPriceContext({
      tariff: TARIFF,
      priceDisplay: 'net',
      taxBasis: 'net',
      pricingFormat: 'compact',
      currency: 'USD',
      language: 'en',
    });
    expect(ctx).toEqual({
      pricingDisplay: '$0.30/kWh + $0.02/min + $1.00 session + $0.10/min idle',
      energyPrice: '$0.30',
      timePrice: '$0.02',
      sessionFee: '$1.00',
      idleFee: '$0.10',
      taxRatePercent: '19',
      pricesIncludeTax: false,
    });
  });

  it('adds the tax to every price for gross display, in the display language', () => {
    const ctx = buildStationPriceContext({
      tariff: TARIFF,
      priceDisplay: 'gross',
      taxBasis: 'net',
      pricingFormat: 'compact',
      currency: 'EUR',
      language: 'de',
    });
    expect(ctx.pricingDisplay).toBe(
      '0,357 €/kWh + 0,0238 €/Min. + 1,19 € pro Ladevorgang + 0,119 €/Min. Standzeit',
    );
    expect(ctx.energyPrice).toBe('0,357 €');
    expect(ctx.taxRatePercent).toBe('19');
    expect(ctx.pricesIncludeTax).toBe(true);
  });

  it('keeps fractional tax rates and sub-cent rates, and shows the session fee as billed', () => {
    const ctx = buildStationPriceContext({
      tariff: { ...TARIFF, pricePerKwh: '0.40', pricePerMinute: null, taxRate: '0.0825' },
      priceDisplay: 'gross',
      taxBasis: 'net',
      pricingFormat: 'standard',
      currency: 'USD',
      language: 'en',
    });
    // Rates keep up to 4 decimals; the flat session fee is money, rounded to the cent.
    expect(ctx.pricingDisplay).toBe('Energy: $0.433/kWh | Session: $1.08 | Idle: $0.1083/min');
    expect(ctx.sessionFee).toBe('$1.08');
    expect(ctx.timePrice).toBe('');
    expect(ctx.taxRatePercent).toBe('8.25');
  });

  it('formats the rate with the decimal separator of the language', () => {
    const ctx = buildStationPriceContext({
      tariff: { ...TARIFF, taxRate: '0.075' },
      priceDisplay: 'net',
      taxBasis: 'net',
      pricingFormat: 'compact',
      currency: 'EUR',
      language: 'de',
    });
    expect(ctx.taxRatePercent).toBe('7,5');
  });

  it('shows the localized free label when no price is above 0', () => {
    const ctx = buildStationPriceContext({
      tariff: {
        pricePerKwh: '0',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        taxRate: null,
      },
      priceDisplay: 'gross',
      taxBasis: 'net',
      pricingFormat: 'compact',
      currency: 'EUR',
      language: 'de',
    });
    expect(ctx.pricingDisplay).toBe('Kostenlos');
    expect(ctx.taxRatePercent).toBe('');
    expect(ctx.pricesIncludeTax).toBe(false);
  });

  it('returns empty prices and no tax note without a tariff', () => {
    expect(
      buildStationPriceContext({
        tariff: null,
        priceDisplay: 'gross',
        taxBasis: 'net',
        pricingFormat: 'compact',
        currency: 'EUR',
        language: 'en',
      }),
    ).toEqual({
      pricingDisplay: '',
      energyPrice: '',
      timePrice: '',
      sessionFee: '',
      idleFee: '',
      taxRatePercent: '',
      pricesIncludeTax: false,
    });
  });
});

describe('stationTaxNoteContext', () => {
  it('has no note without tax, even for gross display', () => {
    expect(stationTaxNoteContext(0, 'gross', 'en')).toEqual({
      taxRatePercent: '',
      pricesIncludeTax: false,
    });
  });

  it('marks gross prices as including tax', () => {
    expect(stationTaxNoteContext(0.2, 'gross', 'zh')).toEqual({
      taxRatePercent: '20',
      pricesIncludeTax: true,
    });
  });
});

describe('station formatters', () => {
  const idleInput = {
    taxBasis: 'net' as const,
    pricePerMinute: '0.10',
    taxRate: '0.19',
    currency: 'EUR',
    language: 'de' as const,
  };

  it('formats a gross-basis idle fee in either price display', () => {
    // 0.119 entered gross at 19% is the same price as 0.10 entered net.
    const gross = { ...idleInput, taxBasis: 'gross' as const, pricePerMinute: '0.119' };
    for (const priceDisplay of ['gross', 'net'] as const) {
      expect(formatStationIdleFeeRate({ ...gross, priceDisplay })).toBe(
        formatStationIdleFeeRate({ ...idleInput, priceDisplay }),
      );
    }
  });

  it('formats the idle fee rate per company price display', () => {
    expect(formatStationIdleFeeRate({ ...idleInput, priceDisplay: 'gross' })).toBe('0,119 €/Min.');
    expect(formatStationIdleFeeRate({ ...idleInput, priceDisplay: 'net' })).toBe('0,10 €/Min.');
    expect(
      formatStationIdleFeeRate({ ...idleInput, pricePerMinute: null, priceDisplay: 'gross' }),
    ).toBe('');
    expect(
      formatStationIdleFeeRate({ ...idleInput, pricePerMinute: '0', priceDisplay: 'net' }),
    ).toBe('');
  });

  it('formats quantities and times in the display language', () => {
    expect(formatStationQuantity(12.4, 'de')).toBe('12,4');
    expect(formatStationQuantity(22, 'en')).toBe('22.0');
    const time = new Date(2026, 0, 1, 15, 45);
    expect(formatStationTime(time, 'en')).toMatch(/^3:45\sPM$/);
    expect(formatStationTime(time, 'de')).toBe('15:45');
  });

  it('formats a time in the given time zone', () => {
    const time = new Date('2026-05-06T15:45:00Z');
    expect(formatStationTime(time, 'de', 'Europe/Berlin')).toBe('17:45');
    expect(formatStationTime(time, 'en', 'America/New_York')).toMatch(/^11:45\sAM$/);
  });

  it('formats the elapsed time in the display language', () => {
    const start = new Date(0);
    const minutes = (n: number): number => n * 60_000;
    expect(formatStationElapsed(start, 'en', minutes(12))).toBe('12m');
    expect(formatStationElapsed(start, 'en', minutes(65))).toBe('1h 5m');
    expect(formatStationElapsed(start, 'en', minutes(120))).toBe('2h 0m');
    expect(formatStationElapsed(start, 'en', 0)).toBe('0m');
    // Other languages use the narrow unit names of the runtime's CLDR data, which
    // change between Node releases (German narrow hours: "1 Std." in CLDR 47,
    // "1h" in CLDR 48). Compare with Intl itself, not a fixed string.
    const narrow = (locale: string, duration: { hours?: number; minutes: number }): string =>
      new Intl.DurationFormat(locale, { style: 'narrow', minutesDisplay: 'always' }).format(
        duration,
      );
    for (const language of ['de', 'es', 'ko', 'zh', 'zh-TW'] as const) {
      const elapsed = formatStationElapsed(start, language, minutes(65));
      expect(elapsed).toBe(narrow(language, { hours: 1, minutes: 5 }));
      expect(elapsed).not.toBe('1h 5m');
    }
    expect(formatStationElapsed(start.toISOString(), 'es', minutes(12))).toBe(
      narrow('es', { minutes: 12 }),
    );
  });

  it('formats no elapsed time without a start or for a future start', () => {
    expect(formatStationElapsed(null, 'en')).toBe('');
    expect(formatStationElapsed(new Date(60_000), 'en', 0)).toBe('');
    expect(formatStationElapsed('not a date', 'en')).toBe('');
  });
});
