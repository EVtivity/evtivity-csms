export const ClearMessageStatusEnum = {
  Accepted: 'Accepted',
  Unknown: 'Unknown',
} as const;

export type ClearMessageStatusEnum = (typeof ClearMessageStatusEnum)[keyof typeof ClearMessageStatusEnum];
