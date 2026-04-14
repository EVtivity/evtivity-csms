export const ClearMonitoringStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NotFound: 'NotFound',
} as const;

export type ClearMonitoringStatusEnum = (typeof ClearMonitoringStatusEnum)[keyof typeof ClearMonitoringStatusEnum];
