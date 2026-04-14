export const StopTransactionPhaseEnum = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  N: 'N',
  'L1-N': 'L1-N',
  'L2-N': 'L2-N',
  'L3-N': 'L3-N',
  'L1-L2': 'L1-L2',
  'L2-L3': 'L2-L3',
  'L3-L1': 'L3-L1',
} as const;

export type StopTransactionPhaseEnum = (typeof StopTransactionPhaseEnum)[keyof typeof StopTransactionPhaseEnum];
