export const TriggerMessageStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NotImplemented: 'NotImplemented',
} as const;

export type TriggerMessageStatusEnum = (typeof TriggerMessageStatusEnum)[keyof typeof TriggerMessageStatusEnum];
