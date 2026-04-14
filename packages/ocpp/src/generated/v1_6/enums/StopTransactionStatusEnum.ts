export const StopTransactionStatusEnum = {
  Accepted: 'Accepted',
  Blocked: 'Blocked',
  Expired: 'Expired',
  Invalid: 'Invalid',
  ConcurrentTx: 'ConcurrentTx',
} as const;

export type StopTransactionStatusEnum = (typeof StopTransactionStatusEnum)[keyof typeof StopTransactionStatusEnum];
