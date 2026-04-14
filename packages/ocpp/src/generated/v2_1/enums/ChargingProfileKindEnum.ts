export const ChargingProfileKindEnum = {
  Absolute: 'Absolute',
  Recurring: 'Recurring',
  Relative: 'Relative',
  Dynamic: 'Dynamic',
} as const;

export type ChargingProfileKindEnum = (typeof ChargingProfileKindEnum)[keyof typeof ChargingProfileKindEnum];
