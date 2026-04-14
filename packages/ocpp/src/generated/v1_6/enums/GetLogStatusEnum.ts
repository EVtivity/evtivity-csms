export const GetLogStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  AcceptedCanceled: 'AcceptedCanceled',
} as const;

export type GetLogStatusEnum = (typeof GetLogStatusEnum)[keyof typeof GetLogStatusEnum];
