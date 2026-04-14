export const RecurrencyKindEnum = {
  Daily: 'Daily',
  Weekly: 'Weekly',
} as const;

export type RecurrencyKindEnum = (typeof RecurrencyKindEnum)[keyof typeof RecurrencyKindEnum];
