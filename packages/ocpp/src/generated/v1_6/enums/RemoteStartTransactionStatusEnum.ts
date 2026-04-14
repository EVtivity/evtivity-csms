export const RemoteStartTransactionStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type RemoteStartTransactionStatusEnum = (typeof RemoteStartTransactionStatusEnum)[keyof typeof RemoteStartTransactionStatusEnum];
