export const ExtendedTriggerMessageStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NotImplemented: 'NotImplemented',
} as const;

export type ExtendedTriggerMessageStatusEnum = (typeof ExtendedTriggerMessageStatusEnum)[keyof typeof ExtendedTriggerMessageStatusEnum];
