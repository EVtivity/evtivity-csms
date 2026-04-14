export const GetLogLogTypeEnum = {
  DiagnosticsLog: 'DiagnosticsLog',
  SecurityLog: 'SecurityLog',
} as const;

export type GetLogLogTypeEnum = (typeof GetLogLogTypeEnum)[keyof typeof GetLogLogTypeEnum];
