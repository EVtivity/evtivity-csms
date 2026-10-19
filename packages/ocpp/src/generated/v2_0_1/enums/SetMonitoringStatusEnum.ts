export const SetMonitoringStatusEnum = {
  Accepted: 'Accepted',
  UnknownComponent: 'UnknownComponent',
  UnknownVariable: 'UnknownVariable',
  UnsupportedMonitorType: 'UnsupportedMonitorType',
  Rejected: 'Rejected',
  Duplicate: 'Duplicate',
} as const;

export type SetMonitoringStatusEnum = (typeof SetMonitoringStatusEnum)[keyof typeof SetMonitoringStatusEnum];
