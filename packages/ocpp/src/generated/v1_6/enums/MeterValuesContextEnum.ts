export const MeterValuesContextEnum = {
  'Interruption.Begin': 'Interruption.Begin',
  'Interruption.End': 'Interruption.End',
  'Sample.Clock': 'Sample.Clock',
  'Sample.Periodic': 'Sample.Periodic',
  'Transaction.Begin': 'Transaction.Begin',
  'Transaction.End': 'Transaction.End',
  Trigger: 'Trigger',
  Other: 'Other',
} as const;

export type MeterValuesContextEnum = (typeof MeterValuesContextEnum)[keyof typeof MeterValuesContextEnum];
