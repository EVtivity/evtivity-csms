export const ChargingProfilePurposeEnum = {
  ChargingStationExternalConstraints: 'ChargingStationExternalConstraints',
  ChargingStationMaxProfile: 'ChargingStationMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
  PriorityCharging: 'PriorityCharging',
  LocalGeneration: 'LocalGeneration',
} as const;

export type ChargingProfilePurposeEnum = (typeof ChargingProfilePurposeEnum)[keyof typeof ChargingProfilePurposeEnum];
