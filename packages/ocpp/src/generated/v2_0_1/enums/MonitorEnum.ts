export const MonitorEnum = {
  UpperThreshold: 'UpperThreshold',
  LowerThreshold: 'LowerThreshold',
  Delta: 'Delta',
  Periodic: 'Periodic',
  PeriodicClockAligned: 'PeriodicClockAligned',
} as const;

export type MonitorEnum = (typeof MonitorEnum)[keyof typeof MonitorEnum];
