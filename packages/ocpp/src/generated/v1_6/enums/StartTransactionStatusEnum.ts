export const StartTransactionStatusEnum = {
  Accepted: 'Accepted',
  Blocked: 'Blocked',
  Expired: 'Expired',
  Invalid: 'Invalid',
  ConcurrentTx: 'ConcurrentTx',
} as const;

export type StartTransactionStatusEnum = (typeof StartTransactionStatusEnum)[keyof typeof StartTransactionStatusEnum];
