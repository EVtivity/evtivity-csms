export const PaymentStatusEnum = {
  Settled: 'Settled',
  Canceled: 'Canceled',
  Rejected: 'Rejected',
  Failed: 'Failed',
} as const;

export type PaymentStatusEnum = (typeof PaymentStatusEnum)[keyof typeof PaymentStatusEnum];
