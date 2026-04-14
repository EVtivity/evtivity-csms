export const ChargingProfileStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type ChargingProfileStatusEnum = (typeof ChargingProfileStatusEnum)[keyof typeof ChargingProfileStatusEnum];
