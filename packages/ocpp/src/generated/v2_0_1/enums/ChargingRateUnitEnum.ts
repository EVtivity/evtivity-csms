export const ChargingRateUnitEnum = {
  W: 'W',
  A: 'A',
} as const;

export type ChargingRateUnitEnum = (typeof ChargingRateUnitEnum)[keyof typeof ChargingRateUnitEnum];
