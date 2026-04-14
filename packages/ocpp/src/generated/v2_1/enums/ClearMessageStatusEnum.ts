export const ClearMessageStatusEnum = {
  Accepted: 'Accepted',
  Unknown: 'Unknown',
  Rejected: 'Rejected',
} as const;

export type ClearMessageStatusEnum = (typeof ClearMessageStatusEnum)[keyof typeof ClearMessageStatusEnum];
