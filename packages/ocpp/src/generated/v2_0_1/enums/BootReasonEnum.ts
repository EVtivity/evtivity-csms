export const BootReasonEnum = {
  ApplicationReset: 'ApplicationReset',
  FirmwareUpdate: 'FirmwareUpdate',
  LocalReset: 'LocalReset',
  PowerUp: 'PowerUp',
  RemoteReset: 'RemoteReset',
  ScheduledReset: 'ScheduledReset',
  Triggered: 'Triggered',
  Unknown: 'Unknown',
  Watchdog: 'Watchdog',
} as const;

export type BootReasonEnum = (typeof BootReasonEnum)[keyof typeof BootReasonEnum];
