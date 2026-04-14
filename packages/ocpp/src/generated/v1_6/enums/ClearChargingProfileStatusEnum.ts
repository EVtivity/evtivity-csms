export const ClearChargingProfileStatusEnum = {
  Accepted: 'Accepted',
  Unknown: 'Unknown',
} as const;

export type ClearChargingProfileStatusEnum = (typeof ClearChargingProfileStatusEnum)[keyof typeof ClearChargingProfileStatusEnum];
