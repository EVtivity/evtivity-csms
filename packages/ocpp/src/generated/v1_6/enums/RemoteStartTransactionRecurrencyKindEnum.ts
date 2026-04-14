export const RemoteStartTransactionRecurrencyKindEnum = {
  Daily: 'Daily',
  Weekly: 'Weekly',
} as const;

export type RemoteStartTransactionRecurrencyKindEnum = (typeof RemoteStartTransactionRecurrencyKindEnum)[keyof typeof RemoteStartTransactionRecurrencyKindEnum];
