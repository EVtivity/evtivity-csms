export const GenericDeviceModelStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NotSupported: 'NotSupported',
  EmptyResultSet: 'EmptyResultSet',
} as const;

export type GenericDeviceModelStatusEnum = (typeof GenericDeviceModelStatusEnum)[keyof typeof GenericDeviceModelStatusEnum];
