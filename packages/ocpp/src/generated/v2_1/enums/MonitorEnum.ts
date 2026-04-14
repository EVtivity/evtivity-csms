export const MonitorEnum = {
  UpperThreshold: 'UpperThreshold',
  LowerThreshold: 'LowerThreshold',
  Delta: 'Delta',
  Periodic: 'Periodic',
  PeriodicClockAligned: 'PeriodicClockAligned',
  TargetDelta: 'TargetDelta',
  TargetDeltaRelative: 'TargetDeltaRelative',
} as const;

export type MonitorEnum = (typeof MonitorEnum)[keyof typeof MonitorEnum];
