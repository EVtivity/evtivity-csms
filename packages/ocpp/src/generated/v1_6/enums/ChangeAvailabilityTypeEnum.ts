export const ChangeAvailabilityTypeEnum = {
  Inoperative: 'Inoperative',
  Operative: 'Operative',
} as const;

export type ChangeAvailabilityTypeEnum = (typeof ChangeAvailabilityTypeEnum)[keyof typeof ChangeAvailabilityTypeEnum];
