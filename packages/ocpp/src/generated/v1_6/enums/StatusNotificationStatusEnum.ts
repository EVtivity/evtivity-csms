export const StatusNotificationStatusEnum = {
  Available: 'Available',
  Preparing: 'Preparing',
  Charging: 'Charging',
  SuspendedEVSE: 'SuspendedEVSE',
  SuspendedEV: 'SuspendedEV',
  Finishing: 'Finishing',
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
} as const;

export type StatusNotificationStatusEnum = (typeof StatusNotificationStatusEnum)[keyof typeof StatusNotificationStatusEnum];
