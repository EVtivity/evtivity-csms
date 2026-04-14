export const RequestStartStopStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type RequestStartStopStatusEnum = (typeof RequestStartStopStatusEnum)[keyof typeof RequestStartStopStatusEnum];
