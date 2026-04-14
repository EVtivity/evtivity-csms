export const SetChargingProfileChargingRateUnitEnum = {
  A: 'A',
  W: 'W',
} as const;

export type SetChargingProfileChargingRateUnitEnum = (typeof SetChargingProfileChargingRateUnitEnum)[keyof typeof SetChargingProfileChargingRateUnitEnum];
