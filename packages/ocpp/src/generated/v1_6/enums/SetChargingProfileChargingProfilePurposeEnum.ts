export const SetChargingProfileChargingProfilePurposeEnum = {
  ChargePointMaxProfile: 'ChargePointMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
} as const;

export type SetChargingProfileChargingProfilePurposeEnum = (typeof SetChargingProfileChargingProfilePurposeEnum)[keyof typeof SetChargingProfileChargingProfilePurposeEnum];
