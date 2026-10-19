export const ReservationUpdateStatusEnum = {
  Expired: 'Expired',
  Removed: 'Removed',
} as const;

export type ReservationUpdateStatusEnum = (typeof ReservationUpdateStatusEnum)[keyof typeof ReservationUpdateStatusEnum];
