export const GetChargingProfileStatusEnum = {
  Accepted: 'Accepted',
  NoProfiles: 'NoProfiles',
} as const;

export type GetChargingProfileStatusEnum = (typeof GetChargingProfileStatusEnum)[keyof typeof GetChargingProfileStatusEnum];
