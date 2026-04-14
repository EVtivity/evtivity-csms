export const ReservationUpdateStatusEnum = {
  Expired: 'Expired',
  Removed: 'Removed',
  NoTransaction: 'NoTransaction',
} as const;

export type ReservationUpdateStatusEnum = (typeof ReservationUpdateStatusEnum)[keyof typeof ReservationUpdateStatusEnum];
