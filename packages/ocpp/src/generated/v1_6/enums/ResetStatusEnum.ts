export const ResetStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type ResetStatusEnum = (typeof ResetStatusEnum)[keyof typeof ResetStatusEnum];
