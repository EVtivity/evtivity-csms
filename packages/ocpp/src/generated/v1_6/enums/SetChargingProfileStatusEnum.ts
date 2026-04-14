export const SetChargingProfileStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NotSupported: 'NotSupported',
} as const;

export type SetChargingProfileStatusEnum = (typeof SetChargingProfileStatusEnum)[keyof typeof SetChargingProfileStatusEnum];
