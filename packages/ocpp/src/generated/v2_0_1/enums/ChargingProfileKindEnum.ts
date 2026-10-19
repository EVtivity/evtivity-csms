export const ChargingProfileKindEnum = {
  Absolute: 'Absolute',
  Recurring: 'Recurring',
  Relative: 'Relative',
} as const;

export type ChargingProfileKindEnum = (typeof ChargingProfileKindEnum)[keyof typeof ChargingProfileKindEnum];
