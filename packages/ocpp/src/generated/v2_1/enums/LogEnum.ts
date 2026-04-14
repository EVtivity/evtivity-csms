export const LogEnum = {
  DiagnosticsLog: 'DiagnosticsLog',
  SecurityLog: 'SecurityLog',
  DataCollectorLog: 'DataCollectorLog',
} as const;

export type LogEnum = (typeof LogEnum)[keyof typeof LogEnum];
