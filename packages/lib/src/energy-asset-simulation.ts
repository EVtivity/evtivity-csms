// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Simulated battery and solar readings for development and demos only
// (`telemetry = 'simulated'`, allowed only where ENERGY_ASSETS_ALLOW_SIMULATED
// is true, owner decision D13). The load management cycle computes them in
// memory each cycle and stores nothing. Pure and browser-safe. Every value
// follows a published model or a named, cited parameter; nothing is random.
//
// Solar (a typical clear-sky day, not a forecast):
//   1. Sun position: NOAA general solar position equations (NOAA Global
//      Monitoring Laboratory, "General Solar Position Calculations",
//      gml.noaa.gov/grad/solcalc/solareqns.PDF).
//   2. Clear-sky global horizontal irradiance: the Haurwitz model,
//      GHI = 1098 x cos(z) x exp(-0.057 / cos(z)) W/m2 (M. Reno, C. Hansen and
//      J. Stein, "Global Horizontal Irradiance Clear Sky Models: Implementation
//      and Analysis", SAND2012-2389, Sandia, 2012, Eq. 18, after B. Haurwitz,
//      J. Meteorology 2, 1945; pvlib-python's `haurwitz` uses 0.059 from
//      Haurwitz 1946, which moves GHI by under 1 percent at 30 degrees sun
//      elevation, derived). The array is taken as flat (the
//      CSMS stores no tilt or azimuth), so the plane of array irradiance is GHI.
//   3. DC power: PVWatts v5, P_dc = P_dc0 x I_poa / 1000 W/m2 (A. Dobos,
//      "PVWatts Version 5 Manual", NREL/TP-6A20-62641, 2014, Eq. 8, p. 9), the
//      cell temperature term left out.
//   4. System losses: the PVWatts default losses (soiling 2, shading 3,
//      mismatch 2, wiring 2, connections 0.5, light-induced degradation 1.5,
//      nameplate 1, availability 3 percent; Dobos 2014, Table 6, p. 10). The
//      manual rounds the total to 14 percent; 14.08 percent is the product
//      1 - (0.98 x 0.97 x 0.98 x 0.98 x 0.995 x 0.985 x 0.99 x 0.97) of the
//      listed losses (derived), so x 0.8592.
//   5. Inverter: the PVWatts nominal inverter efficiency 0.96 (Dobos 2014,
//      p. 11, Eq. 10 and 11), and the AC output clipped at the inverter's AC nameplate
//      (inverter clipping, the PVWatts DC to AC ratio rule).
//
// Battery (a typical day of time-of-use dispatch, integrated each cycle). The
// dispatch follows the site type, which the load management cycle passes in:
//   - Every site but a depot peak-shaves the evening on-peak period of a
//     commercial time-of-use rate: discharge 16:00 to 21:00 site time (PG&E
//     E-TOU-C and the PG&E Business EV rate BEV, peak 4 p.m. to 9 p.m. every
//     day), charge 00:00 to 06:00 (overnight off-peak, from the grid, only with
//     grid charging `possible`) and 10:00 to 15:00 (the midday solar hours).
//     "Energy storage (battery) is effective at mitigating high demand charges
//     due to its ability to shave peaks in demand" (Muratori et al., NREL/PO-
//     5400-72326, EVS 31, 2018).
//   - A depot charges its buses overnight (transit buses dwell 8.1 hours, EPA
//     HD Phase 3 Regulatory Impact Analysis, EPA-420-R-24-006, section 2.6.2.2,
//     Table 2-78, p. 326; the 9-hour window holds it), so its battery charges at
//     midday, 09:00 to 14:00 (the super off-peak period of PG&E BEV, "Super
//     off-peak 9:00 a.m. to 2:00 p.m.", ELEC_SCHEDS_BEV; from the grid or from
//     on-site solar), and discharges through the overnight bus charging block,
//     21:00 to 06:00 (from the end of the on-peak period to the morning
//     pull-out, derived), never charging from the grid overnight while the
//     buses do (the Brookville Smart Energy Bus Depot of Montgomery County, MD,
//     pairs a 4.3 MWh battery with 2 MW of solar canopies for its overnight
//     charging, Montgomery County DOT newsletter, September 2021).
//   - In a discharge window the battery spreads its usable energy evenly over
//     the window (peak shaving at a flat rate, derived): the rate is the lower
//     of its rating and the usable energy over the window hours, and it delivers
//     min(rate, deficit) now. In a charge window it charges at its rating up to
//     the top of its window.
//   - Round-trip efficiency 85 percent, one generic value for a stationary
//     lithium-ion system: "The round-trip efficiency is chosen to be 85%" (Cole
//     and Karmakar, "Cost Projections for Utility-Scale Battery Storage: 2023
//     Update", NREL/TP-6A40-85332, p. 8; PNNL-33283 (2022), Table 4.4, gives
//     86.0 percent AC to AC for LFP). The CSMS stores no efficiency per asset:
//     load management credits a battery from its readings, never from it. Split
//     evenly between charge and discharge: sqrt(0.85) each (derived).
//   - State of charge window: the higher of 10 percent and the asset's reserve
//     to 90 percent, an 80 percent depth of discharge centered (PNNL-33283,
//     Table 6.4, p. 125: LFP at 80 percent depth of discharge; derived). One
//     generic window, like the efficiency.
//   - The state of charge at a time is integrated over the two preceding days
//     from the minimum in 5-minute steps, so the daily cycle has settled and
//     the result depends only on the time (deterministic).

/** Haurwitz clear-sky model constants (SAND2012-2389, Eq. 18). */
export const HAURWITZ = { scale: 1098, extinction: 0.057 } as const;

/** Irradiance at standard test conditions, W/m2 (PVWatts v5, Dobos 2014, Eq. 8, p. 9). */
export const STC_IRRADIANCE_W_M2 = 1000;

/**
 * PVWatts v5 default total system losses: the product of the Table 6 losses
 * (Dobos 2014, p. 10; the manual rounds it to 14 percent), derived.
 */
export const PVWATTS_DEFAULT_LOSSES = 0.1408;

/** PVWatts v5 nominal inverter efficiency (Dobos 2014, p. 11, Eq. 10 and 11). */
export const PVWATTS_INVERTER_EFFICIENCY = 0.96;

interface HourWindow {
  start: number;
  end: number;
}

interface ChargeWindow extends HourWindow {
  /** Charges only from the grid (skipped for a battery that never does). */
  gridOnly: boolean;
}

/** The battery dispatch of a site: peak shaving, or the depot overnight pattern. */
export type SimulatedBatteryDispatch = 'peak_shaving' | 'depot';

/** Discharge and charge windows per dispatch, site time (sources above). */
export const SIMULATED_BATTERY_WINDOWS: Record<
  SimulatedBatteryDispatch,
  { discharge: readonly HourWindow[]; charge: readonly ChargeWindow[] }
> = {
  peak_shaving: {
    discharge: [{ start: 16, end: 21 }],
    charge: [
      { start: 0, end: 6, gridOnly: true },
      { start: 10, end: 15, gridOnly: false },
    ],
  },
  depot: {
    discharge: [
      { start: 21, end: 24 },
      { start: 0, end: 6 },
    ],
    charge: [{ start: 9, end: 14, gridOnly: false }],
  },
};

/** The dispatch of a site type: a depot charges its fleet overnight. */
export function simulatedBatteryDispatch(
  siteType: string | null | undefined,
): SimulatedBatteryDispatch {
  return siteType === 'depot' ? 'depot' : 'peak_shaving';
}

/** Round-trip efficiency (NREL/TP-6A40-85332, stationary lithium-ion). */
export const SIMULATED_ROUND_TRIP_EFFICIENCY = 0.85;

/** Usable state of charge window, percent (80 percent depth of discharge, PNNL-33283). */
export const SIMULATED_SOC_WINDOW = { min: 10, max: 90 } as const;

/** Integration step and span of the battery simulation. */
export const SIMULATED_BATTERY_STEP_MINUTES = 5;
export const SIMULATED_BATTERY_SPAN_HOURS = 48;

const DEG = Math.PI / 180;
const DAY_MS = 86_400_000;

interface SolarTime {
  /** Local true solar time, minutes after local solar midnight (may leave 0 to 1440). */
  trueSolarMinutes: number;
  /** Solar declination, radians. */
  declinationRad: number;
}

/**
 * NOAA general solar position equations: the fractional year gamma, the
 * equation of time and the declination, then the true solar time from UTC
 * and the longitude (east positive).
 */
function solarTime(longitudeDeg: number, at: Date): SolarTime {
  const year = at.getUTCFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dayOfYear = Math.floor((at.getTime() - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / (leap ? 366 : 365)) * (dayOfYear - 1 + (hour - 12) / 24);
  const equationOfTimeMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const declinationRad =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  // UTC time zone: the time offset is the equation of time plus 4 min a degree.
  const trueSolarMinutes = hour * 60 + equationOfTimeMin + 4 * longitudeDeg;
  return { trueSolarMinutes, declinationRad };
}

/** Local true solar time at a longitude, hours 0 to 24. */
export function localSolarHour(longitudeDeg: number, at: Date): number {
  const minutes = solarTime(longitudeDeg, at).trueSolarMinutes;
  return (((minutes / 60) % 24) + 24) % 24;
}

/**
 * Solar elevation above the horizon, degrees (negative at night), from the
 * NOAA equations: hour angle = true solar time / 4 - 180 degrees, cos(zenith)
 * = sin(lat) sin(decl) + cos(lat) cos(decl) cos(hour angle). No refraction.
 */
export function solarElevationDeg(latitudeDeg: number, longitudeDeg: number, at: Date): number {
  const { trueSolarMinutes, declinationRad } = solarTime(longitudeDeg, at);
  const hourAngleRad = (trueSolarMinutes / 4 - 180) * DEG;
  const lat = latitudeDeg * DEG;
  const cosZenith =
    Math.sin(lat) * Math.sin(declinationRad) +
    Math.cos(lat) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  return 90 - zenith / DEG;
}

/** Haurwitz clear-sky global horizontal irradiance, W/m2 (0 with the sun down). */
export function clearSkyGhiWm2(elevationDeg: number): number {
  const cosZenith = Math.sin(elevationDeg * DEG);
  if (cosZenith <= 0) return 0;
  return HAURWITZ.scale * cosZenith * Math.exp(-HAURWITZ.extinction / cosZenith);
}

/**
 * Clear-sky AC output, kW: PVWatts v5 DC power from the irradiance, less the
 * default system losses and the inverter efficiency, clipped at the inverter's
 * AC nameplate when one is known.
 */
export function simulatedSolarKw(
  peakKwp: number,
  elevationDeg: number,
  inverterKw: number | null = null,
): number {
  const dcKw = (peakKwp * clearSkyGhiWm2(elevationDeg)) / STC_IRRADIANCE_W_M2;
  const acKw = dcKw * (1 - PVWATTS_DEFAULT_LOSSES) * PVWATTS_INVERTER_EFFICIENCY;
  return inverterKw != null ? Math.min(acKw, inverterKw) : acKw;
}

export interface SimulatedReading {
  powerKw: number;
  availableKw: number | null;
  socPercent: number | null;
}

/** A solar reading at the site's position and time; null without a position. */
export function simulatedSolarReading(
  peakKwp: number | null,
  inverterKw: number | null,
  latitudeDeg: number | null,
  longitudeDeg: number | null,
  at: Date,
): SimulatedReading | null {
  if (peakKwp == null || latitudeDeg == null || longitudeDeg == null) return null;
  const elevation = solarElevationDeg(latitudeDeg, longitudeDeg, at);
  return {
    powerKw: simulatedSolarKw(peakKwp, elevation, inverterKw),
    availableKw: null,
    socPercent: null,
  };
}

/**
 * The hour of the day at `at` in an IANA time zone, 0 to 24 (fractional);
 * null for a zone the runtime does not know.
 */
export function siteHour(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour + minute / 60;
  } catch {
    // fail-open: an unknown time zone gives no simulated battery reading.
    return null;
  }
}

const inWindow = (hour: number, window: HourWindow): boolean =>
  hour >= window.start && hour < window.end;

/**
 * What the battery does at a site hour under a dispatch: discharge in a
 * discharge window, charge in a charge window. A battery that never charges
 * from the grid skips the grid-only windows.
 */
export function simulatedBatteryMode(
  hour: number,
  gridCharging: 'never' | 'possible',
  dispatch: SimulatedBatteryDispatch,
): 'discharge' | 'charge' | 'idle' {
  const windows = SIMULATED_BATTERY_WINDOWS[dispatch];
  if (windows.discharge.some((w) => inWindow(hour, w))) return 'discharge';
  const charges = windows.charge.some(
    (w) => (!w.gridOnly || gridCharging === 'possible') && inWindow(hour, w),
  );
  return charges ? 'charge' : 'idle';
}

export interface SimulatedBatteryInput {
  capacityKwh: number | null;
  maxDischargeKw: number | null;
  maxChargeKw: number | null;
  inverterKw: number | null;
  reservePercent: number;
  gridCharging: 'never' | 'possible';
  /** The site's dispatch (`simulatedBatteryDispatch` of its site type). */
  dispatch: SimulatedBatteryDispatch;
  /** Demand above the grid capacity the battery covers now, kW (>= 0). */
  deficitKw: number;
}

function lowest(...values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * A battery reading at `at` for a site in `timeZone`; null without a capacity
 * or a known time zone (no reading: no credit, D9 load). The state of charge
 * follows the dispatch above with the round-trip losses. Now: in a discharge
 * window above the minimum it delivers min(rate, deficit) and offers its rate;
 * in a charge window below the maximum it charges at its rating (a load); else
 * it idles and offers its rating while above the minimum.
 */
export function simulatedBatteryReading(
  input: SimulatedBatteryInput,
  timeZone: string | null,
  at: Date,
): SimulatedReading | null {
  const capacity = input.capacityKwh;
  if (capacity == null || capacity <= 0 || timeZone == null) return null;
  const hourNow = siteHour(timeZone, at);
  if (hourNow == null) return null;
  const ratedDischargeKw = Math.max(0, lowest(input.maxDischargeKw, input.inverterKw) ?? 0);
  const chargeKw = Math.max(0, lowest(input.maxChargeKw, input.inverterKw) ?? 0);
  const minSoc = Math.max(SIMULATED_SOC_WINDOW.min, input.reservePercent);
  const maxSoc = SIMULATED_SOC_WINDOW.max;
  if (minSoc >= maxSoc) return { powerKw: 0, availableKw: 0, socPercent: minSoc };
  const oneWay = Math.sqrt(SIMULATED_ROUND_TRIP_EFFICIENCY);
  const minKwh = (capacity * minSoc) / 100;
  const maxKwh = (capacity * maxSoc) / 100;
  // The flat discharge rate: the usable energy, delivered over the window hours.
  const dischargeHours = SIMULATED_BATTERY_WINDOWS[input.dispatch].discharge.reduce(
    (sum, w) => sum + (w.end - w.start),
    0,
  );
  const dischargeKw = Math.min(ratedDischargeKw, ((maxKwh - minKwh) * oneWay) / dischargeHours);

  // Integrate the state of charge over the span before `at` from the minimum.
  const stepH = SIMULATED_BATTERY_STEP_MINUTES / 60;
  const steps = Math.round(SIMULATED_BATTERY_SPAN_HOURS / stepH);
  const startMs = at.getTime() - SIMULATED_BATTERY_SPAN_HOURS * 3_600_000;
  const startHour = siteHour(timeZone, new Date(startMs)) ?? hourNow;
  let socKwh = minKwh;
  for (let i = 0; i < steps; i += 1) {
    // Site hour of the step, from the start hour (a DST change shifts it by an hour at most).
    const hour = (startHour + i * stepH) % 24;
    const mode = simulatedBatteryMode(hour, input.gridCharging, input.dispatch);
    if (mode === 'discharge') socKwh = Math.max(minKwh, socKwh - (dischargeKw * stepH) / oneWay);
    else if (mode === 'charge') socKwh = Math.min(maxKwh, socKwh + chargeKw * stepH * oneWay);
  }
  const socPercent = (socKwh / capacity) * 100;
  const mode = simulatedBatteryMode(hourNow, input.gridCharging, input.dispatch);
  const aboveMin = socKwh > minKwh + 1e-9;
  if (mode === 'charge' && socKwh < maxKwh - 1e-9) {
    return { powerKw: -chargeKw, availableKw: 0, socPercent };
  }
  if (!aboveMin) return { powerKw: 0, availableKw: 0, socPercent };
  if (mode === 'discharge') {
    return {
      powerKw: Math.min(dischargeKw, Math.max(0, input.deficitKw)),
      availableKw: dischargeKw,
      socPercent,
    };
  }
  return { powerKw: 0, availableKw: ratedDischargeKw, socPercent };
}
