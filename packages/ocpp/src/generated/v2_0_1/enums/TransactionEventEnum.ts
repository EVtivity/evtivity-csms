export const TransactionEventEnum = {
  Ended: 'Ended',
  Started: 'Started',
  Updated: 'Updated',
} as const;

export type TransactionEventEnum = (typeof TransactionEventEnum)[keyof typeof TransactionEventEnum];
