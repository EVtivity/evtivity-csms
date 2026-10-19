export const LogStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  AcceptedCanceled: 'AcceptedCanceled',
} as const;

export type LogStatusEnum = (typeof LogStatusEnum)[keyof typeof LogStatusEnum];
