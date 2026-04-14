// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Average CO2 emissions from gasoline driving expressed as kg CO2 per kWh-equivalent.
 * Based on EPA average: a gasoline car emits ~0.46 kg CO2 per kWh of energy that
 * an EV would use to travel the same distance.
 */
export const GASOLINE_CO2_KG_PER_KWH = 0.46;

/**
 * Calculate the CO2 avoided by charging an EV instead of driving a gasoline car.
 *
 * @param energyDeliveredWh - Energy delivered to the vehicle in watt-hours
 * @param gridCarbonIntensityKgPerKwh - Grid carbon intensity in kg CO2 per kWh
 * @returns CO2 avoided in kilograms, rounded to 2 decimal places
 */
export function calculateCo2AvoidedKg(
  energyDeliveredWh: number,
  gridCarbonIntensityKgPerKwh: number,
): number {
  const energyKwh = energyDeliveredWh / 1000;
  const gasolineCo2Kg = energyKwh * GASOLINE_CO2_KG_PER_KWH;
  const gridCo2Kg = energyKwh * gridCarbonIntensityKgPerKwh;
  return Math.round((gasolineCo2Kg - gridCo2Kg) * 100) / 100;
}
