export const ReadingContextEnum = {
  'Interruption.Begin': 'Interruption.Begin',
  'Interruption.End': 'Interruption.End',
  Other: 'Other',
  'Sample.Clock': 'Sample.Clock',
  'Sample.Periodic': 'Sample.Periodic',
  'Transaction.Begin': 'Transaction.Begin',
  'Transaction.End': 'Transaction.End',
  Trigger: 'Trigger',
} as const;

export type ReadingContextEnum = (typeof ReadingContextEnum)[keyof typeof ReadingContextEnum];
