export const AuthorizeStatusEnum = {
  Accepted: 'Accepted',
  Blocked: 'Blocked',
  Expired: 'Expired',
  Invalid: 'Invalid',
  ConcurrentTx: 'ConcurrentTx',
} as const;

export type AuthorizeStatusEnum = (typeof AuthorizeStatusEnum)[keyof typeof AuthorizeStatusEnum];
