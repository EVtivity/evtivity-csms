export const BootNotificationStatusEnum = {
  Accepted: 'Accepted',
  Pending: 'Pending',
  Rejected: 'Rejected',
} as const;

export type BootNotificationStatusEnum = (typeof BootNotificationStatusEnum)[keyof typeof BootNotificationStatusEnum];
