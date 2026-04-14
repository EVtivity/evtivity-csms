export const OperationModeEnum = {
  Idle: 'Idle',
  ChargingOnly: 'ChargingOnly',
  CentralSetpoint: 'CentralSetpoint',
  ExternalSetpoint: 'ExternalSetpoint',
  ExternalLimits: 'ExternalLimits',
  CentralFrequency: 'CentralFrequency',
  LocalFrequency: 'LocalFrequency',
  LocalLoadBalancing: 'LocalLoadBalancing',
} as const;

export type OperationModeEnum = (typeof OperationModeEnum)[keyof typeof OperationModeEnum];
