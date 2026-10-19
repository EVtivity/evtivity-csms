export const ChangeAvailabilityStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Scheduled: 'Scheduled',
} as const;

export type ChangeAvailabilityStatusEnum = (typeof ChangeAvailabilityStatusEnum)[keyof typeof ChangeAvailabilityStatusEnum];
