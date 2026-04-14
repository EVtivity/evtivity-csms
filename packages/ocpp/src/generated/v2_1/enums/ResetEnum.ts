export const ResetEnum = {
  Immediate: 'Immediate',
  OnIdle: 'OnIdle',
  ImmediateAndResume: 'ImmediateAndResume',
} as const;

export type ResetEnum = (typeof ResetEnum)[keyof typeof ResetEnum];
