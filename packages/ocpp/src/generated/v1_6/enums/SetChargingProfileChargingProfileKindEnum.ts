export const SetChargingProfileChargingProfileKindEnum = {
  Absolute: 'Absolute',
  Recurring: 'Recurring',
  Relative: 'Relative',
} as const;

export type SetChargingProfileChargingProfileKindEnum = (typeof SetChargingProfileChargingProfileKindEnum)[keyof typeof SetChargingProfileChargingProfileKindEnum];
