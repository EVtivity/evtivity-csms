export const ResetTypeEnum = {
  Hard: 'Hard',
  Soft: 'Soft',
} as const;

export type ResetTypeEnum = (typeof ResetTypeEnum)[keyof typeof ResetTypeEnum];
