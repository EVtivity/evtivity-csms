export const ChargingProfilePurposeEnum = {
  ChargingStationExternalConstraints: 'ChargingStationExternalConstraints',
  ChargingStationMaxProfile: 'ChargingStationMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
} as const;

export type ChargingProfilePurposeEnum = (typeof ChargingProfilePurposeEnum)[keyof typeof ChargingProfilePurposeEnum];
