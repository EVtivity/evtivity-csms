export const MonitoringCriterionEnum = {
  ThresholdMonitoring: 'ThresholdMonitoring',
  DeltaMonitoring: 'DeltaMonitoring',
  PeriodicMonitoring: 'PeriodicMonitoring',
} as const;

export type MonitoringCriterionEnum = (typeof MonitoringCriterionEnum)[keyof typeof MonitoringCriterionEnum];
