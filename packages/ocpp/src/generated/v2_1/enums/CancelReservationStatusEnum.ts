export const CancelReservationStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type CancelReservationStatusEnum = (typeof CancelReservationStatusEnum)[keyof typeof CancelReservationStatusEnum];
