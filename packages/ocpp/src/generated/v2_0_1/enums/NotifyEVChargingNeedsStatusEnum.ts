export const NotifyEVChargingNeedsStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Processing: 'Processing',
} as const;

export type NotifyEVChargingNeedsStatusEnum = (typeof NotifyEVChargingNeedsStatusEnum)[keyof typeof NotifyEVChargingNeedsStatusEnum];
