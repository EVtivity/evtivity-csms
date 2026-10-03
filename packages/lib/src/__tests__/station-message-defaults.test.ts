// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Handlebars from 'handlebars';
import {
  STATION_MESSAGE_DEFAULTS,
  STATION_MESSAGE_LANGUAGES,
  STATION_PER_MINUTE_LABELS,
  STATION_PRICE_SUMMARY_LABELS,
  DEFAULT_STATION_MESSAGE_LANGUAGE,
  isStationMessageLanguage,
} from '../station-message-defaults.js';
import type { StationMessageState } from '../station-message.js';

const EXPECTED_STATES: StationMessageState[] = [
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
  'payment_failed',
  'payment_required',
  'guest_unauthorized',
  'unauthorized',
];

describe('STATION_MESSAGE_LANGUAGES', () => {
  it('lists the six UI languages with English as the default', () => {
    expect([...STATION_MESSAGE_LANGUAGES]).toEqual(['en', 'de', 'es', 'ko', 'zh', 'zh-TW']);
    expect(DEFAULT_STATION_MESSAGE_LANGUAGE).toBe('en');
  });

  it('accepts only supported language codes', () => {
    expect(isStationMessageLanguage('de')).toBe(true);
    expect(isStationMessageLanguage('zh-TW')).toBe(true);
    expect(isStationMessageLanguage('fr')).toBe(false);
    expect(isStationMessageLanguage('DE')).toBe(false);
    expect(isStationMessageLanguage(null)).toBe(false);
  });
});

describe('STATION_MESSAGE_DEFAULTS', () => {
  it('has a template set for every language', () => {
    expect(Object.keys(STATION_MESSAGE_DEFAULTS).sort()).toEqual(
      [...STATION_MESSAGE_LANGUAGES].sort(),
    );
  });

  for (const language of STATION_MESSAGE_LANGUAGES) {
    describe(language, () => {
      const defaults = STATION_MESSAGE_DEFAULTS[language];

      it('covers every StationMessageState with no extras', () => {
        expect(Object.keys(defaults).sort()).toEqual([...EXPECTED_STATES].sort());
      });

      it('provides a non-empty template that compiles for every state', () => {
        for (const state of EXPECTED_STATES) {
          const body = defaults[state];
          expect(body.trim().length).toBeGreaterThan(0);
          expect(() => Handlebars.compile(body, { noEscape: true })({})).not.toThrow();
        }
      });

      it('shows prices and the tax note on the available screen', () => {
        const body = defaults.available;
        expect(body).toContain('{{companyName}}');
        expect(body).toContain('{{stationOcppId}}');
        expect(body).toContain('{{pricingDisplay}}');
        expect(body).toContain('{{#if taxRatePercent}}');
        expect(body).toContain('{{#if pricesIncludeTax}}');
        expect(body).toContain('{{taxRatePercent}}');
      });

      it('exposes live charging metrics in the charging template', () => {
        const body = defaults.charging;
        expect(body).toContain('{{energyKwh}}');
        expect(body).toContain('{{powerKw}}');
        expect(body).toContain('{{costFormatted}}');
        expect(body).toContain('{{elapsedFormatted}}');
      });

      it('guards optional values behind Handlebars conditionals', () => {
        expect(defaults.reserved).toContain('{{#if driverFirstName}}');
        expect(defaults.reserved).toContain('{{reservationExpiresAt}}');
        expect(defaults.suspended).toContain('{{#if idleFeeRate}}');
        expect(defaults.charging).toContain('{{#if powerKw}}');
        expect(defaults.faulted).toContain('{{supportPhone}}');
        expect(defaults.payment_failed).toContain('{{#if supportPhone}}');
      });

      it('balances every Handlebars conditional', () => {
        for (const state of EXPECTED_STATES) {
          const body = defaults[state];
          const opens = (body.match(/{{#if/g) ?? []).length;
          const closes = (body.match(/{{\/if}}/g) ?? []).length;
          expect(opens).toBe(closes);
        }
      });

      it('has price summary labels with a price placeholder', () => {
        for (const format of ['compact', 'standard'] as const) {
          const labels = STATION_PRICE_SUMMARY_LABELS[language][format];
          for (const pattern of [labels.energy, labels.time, labels.session, labels.idle]) {
            expect(pattern).toContain('{price}');
          }
          expect(labels.free.length).toBeGreaterThan(0);
        }
        expect(STATION_PER_MINUTE_LABELS[language]).toContain('{price}');
      });
    });
  }

  it('words the English tax note as incl. or excl. with the rate', () => {
    const render = Handlebars.compile(STATION_MESSAGE_DEFAULTS.en.available, { noEscape: true });
    const base = { companyName: 'ACME', stationOcppId: 'CS-1', pricingDisplay: '$0.36/kWh' };
    expect(render({ ...base, taxRatePercent: '19', pricesIncludeTax: true })).toBe(
      'ACME\nCS-1\n$0.36/kWh\nincl. 19% tax\nPlug in to start',
    );
    expect(render({ ...base, taxRatePercent: '8.25', pricesIncludeTax: false })).toBe(
      'ACME\nCS-1\n$0.36/kWh\nexcl. 8.25% tax\nPlug in to start',
    );
    expect(render({ ...base, taxRatePercent: '', pricesIncludeTax: false })).toBe(
      'ACME\nCS-1\n$0.36/kWh\nPlug in to start',
    );
  });

  it('words the German tax note as inkl. or zzgl. MwSt.', () => {
    const render = Handlebars.compile(STATION_MESSAGE_DEFAULTS.de.available, { noEscape: true });
    const base = { companyName: 'ACME', stationOcppId: 'CS-1', pricingDisplay: '0,357 €/kWh' };
    expect(render({ ...base, taxRatePercent: '19', pricesIncludeTax: true })).toContain(
      'inkl. 19 % MwSt.',
    );
    expect(render({ ...base, taxRatePercent: '19', pricesIncludeTax: false })).toContain(
      'zzgl. 19 % MwSt.',
    );
  });
});
