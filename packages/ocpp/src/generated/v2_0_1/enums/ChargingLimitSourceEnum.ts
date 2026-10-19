export const ChargingLimitSourceEnum = {
  EMS: 'EMS',
  Other: 'Other',
  SO: 'SO',
  CSO: 'CSO',
} as const;

export type ChargingLimitSourceEnum = (typeof ChargingLimitSourceEnum)[keyof typeof ChargingLimitSourceEnum];
