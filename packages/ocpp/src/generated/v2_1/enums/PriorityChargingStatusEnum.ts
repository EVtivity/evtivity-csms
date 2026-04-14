export const PriorityChargingStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NoProfile: 'NoProfile',
} as const;

export type PriorityChargingStatusEnum = (typeof PriorityChargingStatusEnum)[keyof typeof PriorityChargingStatusEnum];
