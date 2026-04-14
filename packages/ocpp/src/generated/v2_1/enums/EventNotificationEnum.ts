export const EventNotificationEnum = {
  HardWiredNotification: 'HardWiredNotification',
  HardWiredMonitor: 'HardWiredMonitor',
  PreconfiguredMonitor: 'PreconfiguredMonitor',
  CustomMonitor: 'CustomMonitor',
} as const;

export type EventNotificationEnum = (typeof EventNotificationEnum)[keyof typeof EventNotificationEnum];
