export const ResetStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Scheduled: 'Scheduled',
} as const;

export type ResetStatusEnum = (typeof ResetStatusEnum)[keyof typeof ResetStatusEnum];
