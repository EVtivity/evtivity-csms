export const SetNetworkProfileStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Failed: 'Failed',
} as const;

export type SetNetworkProfileStatusEnum = (typeof SetNetworkProfileStatusEnum)[keyof typeof SetNetworkProfileStatusEnum];
