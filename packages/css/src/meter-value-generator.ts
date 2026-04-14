// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface ChargingProfile {
  connectorType: 'ac_type2' | 'ac_type1' | 'dc_ccs2' | 'dc_ccs1' | 'dc_chademo';
  maxPowerW: number;
  phases: number;
  voltage: number;
}

const DEFAULT_PROFILE: ChargingProfile = {
  connectorType: 'ac_type2',
  maxPowerW: 22000,
  phases: 3,
  voltage: 230,
};

export interface SampledValue {
  value: string | number;
  measurand: string;
  unit?: string;
  unitOfMeasure?: { unit: string };
  context?: string;
}

const MEASURAND_UNITS: Record<string, string> = {
  'Energy.Active.Import.Register': 'Wh',
  'Energy.Active.Export.Register': 'Wh',
  'Power.Active.Import': 'W',
  'Power.Active.Export': 'W',
  'Power.Reactive.Import': 'var',
  'Current.Import': 'A',
  'Current.Export': 'A',
  Voltage: 'V',
  SoC: 'Percent',
  Temperature: 'Celsius',
  Frequency: 'Hz',
  'Power.Offered': 'W',
};

// Measurands valid per protocol. "Temperature" and "RPM" exist in 1.6 but not 2.1.
// See schemas/ocpp-2.1/MeterValuesRequest.json MeasurandEnumType.
const OCPP_16_ONLY_MEASURANDS = new Set(['Temperature', 'RPM']);

// OCPP 1.6 unit enum from schemas/ocpp-1.6/MeterValues.json.
// "Hz" is not in the 1.6 unit enum so must be omitted for Frequency.
const OCPP_16_VALID_UNITS = new Set([
  'Wh',
  'kWh',
  'varh',
  'kvarh',
  'W',
  'kW',
  'VA',
  'kVA',
  'var',
  'kvar',
  'A',
  'V',
  'K',
  'Celcius',
  'Celsius',
  'Fahrenheit',
  'Percent',
]);

export class MeterValueGenerator {
  private meterWh = 0;
  private powerW = 0;
  private voltage: number;
  private currentA = 0;
  private frequency = 50;
  private temperature = 25;
  private soc = 20;
  private tickCount = 0;

  constructor(private readonly profile: ChargingProfile = DEFAULT_PROFILE) {
    this.voltage = profile.voltage;
  }

  /** Call once per meter interval to advance simulation state */
  tick(idle: boolean, powerLimitW: number | null): void {
    this.tickCount++;

    if (idle) {
      this.powerW = 0;
      this.currentA = 0;
      this.voltage = this.profile.voltage;
      // Temperature slowly cools down when idle
      this.temperature = Math.max(25, this.temperature - 0.2);
    } else {
      const isDc =
        this.profile.connectorType === 'dc_ccs2' ||
        this.profile.connectorType === 'dc_ccs1' ||
        this.profile.connectorType === 'dc_chademo';

      if (isDc) {
        this.tickDc(powerLimitW);
      } else {
        this.tickAc(powerLimitW);
      }

      this.temperature = Math.min(45, 25 + this.tickCount * 0.5);
    }

    this.frequency = 49.9 + Math.random() * 0.2;
  }

  private tickAc(powerLimitW: number | null): void {
    // Flat power at ~95% of maxPowerW with +/- 5% random variation
    const variation = 0.9 + Math.random() * 0.1; // 0.90 to 1.00, centered around 0.95
    let power = Math.floor(this.profile.maxPowerW * 0.95 * variation);

    if (powerLimitW != null) {
      power = Math.min(power, powerLimitW);
    }

    this.powerW = power;
    this.meterWh += Math.floor((this.powerW * 10) / 3600);
    this.voltage = this.profile.voltage - 2 + Math.random() * 4;
    this.currentA = this.powerW / this.voltage / this.profile.phases;
    // SoC ramps ~0.3% per tick (roughly 1% per 30s at 7kW on a 60kWh battery)
    this.soc = Math.min(100, this.soc + (this.powerW > 0 ? 0.3 : 0));
  }

  private tickDc(powerLimitW: number | null): void {
    const isChademo = this.profile.connectorType === 'dc_chademo';

    // DC voltage range depends on connector type
    if (isChademo) {
      this.voltage = 300 + Math.random() * 150; // 300-450V
    } else {
      this.voltage = 350 + Math.random() * 150; // 350-500V
    }

    // Power curve: constant up to 80% SoC, linear taper from 80% to 100%
    let powerFraction: number;
    if (this.soc < 80) {
      powerFraction = 0.95;
    } else {
      // Linear taper: 95% at 80% SoC down to 20% at 100% SoC
      const taperProgress = (this.soc - 80) / 20; // 0.0 at 80%, 1.0 at 100%
      powerFraction = 0.95 - taperProgress * 0.75; // 0.95 -> 0.20
    }

    // Apply small random variation (+/- 5%)
    const variation = 0.95 + Math.random() * 0.1;
    let power = Math.floor(this.profile.maxPowerW * powerFraction * variation);

    if (powerLimitW != null) {
      power = Math.min(power, powerLimitW);
    }

    this.powerW = power;
    this.meterWh += Math.floor((this.powerW * 10) / 3600);
    this.currentA = this.powerW / this.voltage; // DC is single phase

    // SoC ramps proportional to power (faster at higher power)
    // At max power (~95%), ramp ~0.8% per tick. Scale down with power.
    const powerRatio = this.powerW / this.profile.maxPowerW;
    this.soc = Math.min(100, this.soc + powerRatio * 0.8);
  }

  /** Reset session-scoped state (SoC, temperature, tick count). Energy stays cumulative. */
  resetSession(): void {
    this.tickCount = 0;
    this.temperature = 25;
    this.soc = 15 + Math.random() * 15; // random 15-30% start SoC
    this.powerW = 0;
    this.currentA = 0;
  }

  /** Get current energy in Wh */
  get energyWh(): number {
    return this.meterWh;
  }

  /** Get current power in W */
  get currentPowerW(): number {
    return this.powerW;
  }

  /** Generate sampled values for the requested measurands */
  generate(measurands: string[], isOcpp16: boolean): SampledValue[] {
    const result: SampledValue[] = [];
    for (const m of measurands) {
      // Skip measurands not valid for the target protocol
      if (!isOcpp16 && OCPP_16_ONLY_MEASURANDS.has(m)) continue;
      const raw = this.getValue(m);
      if (raw == null) continue;
      const unit = MEASURAND_UNITS[m] ?? '';
      if (isOcpp16) {
        // Omit unit if not in the 1.6 unit enum (field is optional)
        const sv: SampledValue = { value: String(raw), measurand: m };
        if (OCPP_16_VALID_UNITS.has(unit)) sv.unit = unit;
        result.push(sv);
      } else {
        result.push({ value: raw, measurand: m, unitOfMeasure: { unit } });
      }
    }
    return result;
  }

  private getValue(measurand: string): number | null {
    switch (measurand) {
      case 'Energy.Active.Import.Register':
        return this.meterWh;
      case 'Energy.Active.Export.Register':
        return 0;
      case 'Power.Active.Import':
        return this.powerW;
      case 'Power.Active.Export':
        return 0;
      case 'Power.Reactive.Import':
        return Math.floor(this.powerW * 0.1);
      case 'Current.Import':
        return Math.round(this.currentA * 10) / 10;
      case 'Current.Export':
        return 0;
      case 'Voltage':
        return Math.round(this.voltage * 10) / 10;
      case 'SoC':
        return Math.round(this.soc * 10) / 10;
      case 'Temperature':
        return Math.round(this.temperature * 10) / 10;
      case 'Frequency':
        return Math.round(this.frequency * 10) / 10;
      case 'Power.Offered':
        return this.profile.maxPowerW;
      default:
        return null;
    }
  }
}
