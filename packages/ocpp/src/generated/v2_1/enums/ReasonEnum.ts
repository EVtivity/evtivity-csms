export const ReasonEnum = {
  DeAuthorized: 'DeAuthorized',
  EmergencyStop: 'EmergencyStop',
  EnergyLimitReached: 'EnergyLimitReached',
  EVDisconnected: 'EVDisconnected',
  GroundFault: 'GroundFault',
  ImmediateReset: 'ImmediateReset',
  MasterPass: 'MasterPass',
  Local: 'Local',
  LocalOutOfCredit: 'LocalOutOfCredit',
  Other: 'Other',
  OvercurrentFault: 'OvercurrentFault',
  PowerLoss: 'PowerLoss',
  PowerQuality: 'PowerQuality',
  Reboot: 'Reboot',
  Remote: 'Remote',
  SOCLimitReached: 'SOCLimitReached',
  StoppedByEV: 'StoppedByEV',
  TimeLimitReached: 'TimeLimitReached',
  Timeout: 'Timeout',
  ReqEnergyTransferRejected: 'ReqEnergyTransferRejected',
} as const;

export type ReasonEnum = (typeof ReasonEnum)[keyof typeof ReasonEnum];
