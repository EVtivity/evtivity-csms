export const ResetEnum = {
  Immediate: 'Immediate',
  OnIdle: 'OnIdle',
} as const;

export type ResetEnum = (typeof ResetEnum)[keyof typeof ResetEnum];
