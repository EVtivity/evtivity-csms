export const ClearCacheStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type ClearCacheStatusEnum = (typeof ClearCacheStatusEnum)[keyof typeof ClearCacheStatusEnum];
