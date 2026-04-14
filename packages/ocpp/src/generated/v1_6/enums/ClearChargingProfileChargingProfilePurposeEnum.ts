export const ClearChargingProfileChargingProfilePurposeEnum = {
  ChargePointMaxProfile: 'ChargePointMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
} as const;

export type ClearChargingProfileChargingProfilePurposeEnum = (typeof ClearChargingProfileChargingProfilePurposeEnum)[keyof typeof ClearChargingProfileChargingProfilePurposeEnum];
