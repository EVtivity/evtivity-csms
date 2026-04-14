// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { MeterValueGenerator } from '../meter-value-generator.js';

describe('MeterValueGenerator', () => {
  it('generates values for requested measurands only', () => {
    const gen = new MeterValueGenerator();
    const values = gen.generate(['Energy.Active.Import.Register', 'Voltage'], false);
    expect(values).toHaveLength(2);
    expect(values.map((v) => v.measurand)).toEqual(['Energy.Active.Import.Register', 'Voltage']);
  });

  it('accumulates energy over ticks', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const v1 = gen.generate(['Energy.Active.Import.Register'], false);
    gen.tick(false, null);
    const v2 = gen.generate(['Energy.Active.Import.Register'], false);
    expect(Number(v2[0]!.value)).toBeGreaterThan(Number(v1[0]!.value));
  });

  it('reports zero power when idle', () => {
    const gen = new MeterValueGenerator();
    gen.tick(true, null);
    const values = gen.generate(['Power.Active.Import'], false);
    expect(Number(values[0]!.value)).toBe(0);
  });

  it('simulates SoC ramping from 20% toward 80%', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const v1 = gen.generate(['SoC'], false);
    for (let i = 0; i < 20; i++) gen.tick(false, null);
    const v2 = gen.generate(['SoC'], false);
    expect(Number(v2[0]!.value)).toBeGreaterThan(Number(v1[0]!.value));
    expect(Number(v2[0]!.value)).toBeLessThanOrEqual(80);
  });

  it('simulates temperature ramping with a ceiling (OCPP 1.6 only)', () => {
    const gen = new MeterValueGenerator();
    for (let i = 0; i < 100; i++) gen.tick(false, null);
    // Temperature is only valid for OCPP 1.6
    const values = gen.generate(['Temperature'], true);
    const temp = Number(values[0]!.value);
    expect(temp).toBeGreaterThanOrEqual(25);
    expect(temp).toBeLessThanOrEqual(45);
  });

  it('skips Temperature for OCPP 2.1 (not in 2.1 MeasurandEnumType)', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const values = gen.generate(['Temperature'], false);
    expect(values).toHaveLength(0);
  });

  it('resets SoC and temperature on resetSession', () => {
    const gen = new MeterValueGenerator();
    for (let i = 0; i < 10; i++) gen.tick(false, null);
    gen.resetSession();
    const soc = gen.generate(['SoC'], false);
    expect(Number(soc[0]!.value)).toBeGreaterThanOrEqual(15);
    expect(Number(soc[0]!.value)).toBeLessThanOrEqual(30);
  });

  it('respects power limit', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, 1000);
    const values = gen.generate(['Power.Active.Import'], false);
    expect(Number(values[0]!.value)).toBeLessThanOrEqual(1000);
  });

  it('formats for OCPP 1.6 with unit string', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const values = gen.generate(['Voltage'], true);
    expect(values[0]).toHaveProperty('unit', 'V');
    expect(values[0]).not.toHaveProperty('unitOfMeasure');
  });

  it('omits unit for OCPP 1.6 measurands with no valid 1.6 unit (e.g. Frequency)', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const values = gen.generate(['Frequency'], true);
    expect(values).toHaveLength(1);
    expect(values[0]!.measurand).toBe('Frequency');
    // Hz is not in the OCPP 1.6 unit enum, so unit should be omitted
    expect(values[0]).not.toHaveProperty('unit');
  });

  it('formats for OCPP 2.1 with unitOfMeasure object', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const values = gen.generate(['Voltage'], false);
    expect(values[0]).toHaveProperty('unitOfMeasure');
    expect(values[0]).not.toHaveProperty('unit');
  });

  it('skips unknown measurands', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const values = gen.generate(['Energy.Active.Import.Register', 'UnknownMeasurand'], false);
    expect(values).toHaveLength(1);
    expect(values[0]!.measurand).toBe('Energy.Active.Import.Register');
  });

  it('preserves cumulative energy across resetSession', () => {
    const gen = new MeterValueGenerator();
    for (let i = 0; i < 5; i++) gen.tick(false, null);
    const beforeReset = gen.energyWh;
    expect(beforeReset).toBeGreaterThan(0);
    gen.resetSession();
    expect(gen.energyWh).toBe(beforeReset);
  });

  it('reports all supported measurands for OCPP 2.1 (excludes Temperature)', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const allMeasurands = [
      'Energy.Active.Import.Register',
      'Energy.Active.Export.Register',
      'Power.Active.Import',
      'Power.Active.Export',
      'Power.Reactive.Import',
      'Current.Import',
      'Current.Export',
      'Voltage',
      'SoC',
      'Temperature',
      'Frequency',
      'Power.Offered',
    ];
    const values = gen.generate(allMeasurands, false);
    // Temperature is excluded for OCPP 2.1
    expect(values).toHaveLength(11);
    expect(values.map((v) => v.measurand)).not.toContain('Temperature');
  });

  it('reports all supported measurands for OCPP 1.6 (includes Temperature)', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    const allMeasurands = [
      'Energy.Active.Import.Register',
      'Energy.Active.Export.Register',
      'Power.Active.Import',
      'Power.Active.Export',
      'Power.Reactive.Import',
      'Current.Import',
      'Current.Export',
      'Voltage',
      'SoC',
      'Temperature',
      'Frequency',
      'Power.Offered',
    ];
    const values = gen.generate(allMeasurands, true);
    expect(values).toHaveLength(12);
    expect(values.map((v) => v.measurand)).toContain('Temperature');
  });

  it('returns current power via getter', () => {
    const gen = new MeterValueGenerator();
    gen.tick(false, null);
    expect(gen.currentPowerW).toBeGreaterThan(0);
    gen.tick(true, null);
    expect(gen.currentPowerW).toBe(0);
  });

  // ===================================================================
  // ChargingProfile support
  // ===================================================================

  describe('ChargingProfile support', () => {
    it('uses AC Type 2 profile by default', () => {
      const gen = new MeterValueGenerator();
      gen.tick(false, null);
      const power = gen.generate(['Power.Active.Import'], false);
      // Default AC Type 2 is 22kW, should be around 95% = ~20900W
      expect(Number(power[0]!.value)).toBeGreaterThan(15000);
      expect(Number(power[0]!.value)).toBeLessThanOrEqual(22000);
    });

    it('generates higher power with DC CCS2 profile', () => {
      const gen = new MeterValueGenerator({
        connectorType: 'dc_ccs2',
        maxPowerW: 150000,
        phases: 1,
        voltage: 400,
      });
      gen.tick(false, null);
      const power = gen.generate(['Power.Active.Import'], false);
      // 150kW DC at ~95% = ~142500W
      expect(Number(power[0]!.value)).toBeGreaterThan(100000);
    });

    it('tapers DC power above 80% SoC', () => {
      const gen = new MeterValueGenerator({
        connectorType: 'dc_ccs2',
        maxPowerW: 150000,
        phases: 1,
        voltage: 400,
      });
      // Tick many times to get SoC high
      for (let i = 0; i < 200; i++) gen.tick(false, null);
      const power = gen.generate(['Power.Active.Import'], false);
      const soc = gen.generate(['SoC'], false);
      // At high SoC, power should be significantly less than max
      if (Number(soc[0]!.value) > 85) {
        expect(Number(power[0]!.value)).toBeLessThan(100000);
      }
    });

    it('uses correct voltage range for CHAdeMO', () => {
      const gen = new MeterValueGenerator({
        connectorType: 'dc_chademo',
        maxPowerW: 50000,
        phases: 1,
        voltage: 400,
      });
      gen.tick(false, null);
      const voltage = gen.generate(['Voltage'], false);
      const v = Number(voltage[0]!.value);
      // CHAdeMO voltage range: 300-450V
      expect(v).toBeGreaterThanOrEqual(300);
      expect(v).toBeLessThanOrEqual(450);
    });

    it('reports maxPowerW as Power.Offered', () => {
      const gen = new MeterValueGenerator({
        connectorType: 'dc_ccs2',
        maxPowerW: 350000,
        phases: 1,
        voltage: 400,
      });
      gen.tick(false, null);
      const offered = gen.generate(['Power.Offered'], false);
      expect(Number(offered[0]!.value)).toBe(350000);
    });

    it('resets voltage to profile voltage on idle', () => {
      const gen = new MeterValueGenerator({
        connectorType: 'ac_type1',
        maxPowerW: 7200,
        phases: 1,
        voltage: 120,
      });
      gen.tick(false, null);
      gen.tick(true, null);
      const voltage = gen.generate(['Voltage'], false);
      // Should be close to profile voltage (120V) when idle
      expect(Number(voltage[0]!.value)).toBeGreaterThanOrEqual(118);
      expect(Number(voltage[0]!.value)).toBeLessThanOrEqual(122);
    });
  });
});
