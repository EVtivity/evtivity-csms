export const RemoteStopTransactionStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type RemoteStopTransactionStatusEnum = (typeof RemoteStopTransactionStatusEnum)[keyof typeof RemoteStopTransactionStatusEnum];
