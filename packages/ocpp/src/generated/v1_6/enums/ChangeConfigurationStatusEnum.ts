export const ChangeConfigurationStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  RebootRequired: 'RebootRequired',
  NotSupported: 'NotSupported',
} as const;

export type ChangeConfigurationStatusEnum = (typeof ChangeConfigurationStatusEnum)[keyof typeof ChangeConfigurationStatusEnum];
