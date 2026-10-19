export const LogEnum = {
  DiagnosticsLog: 'DiagnosticsLog',
  SecurityLog: 'SecurityLog',
} as const;

export type LogEnum = (typeof LogEnum)[keyof typeof LogEnum];
