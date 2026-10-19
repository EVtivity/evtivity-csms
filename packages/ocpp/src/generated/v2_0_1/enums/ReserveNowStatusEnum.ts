export const ReserveNowStatusEnum = {
  Accepted: 'Accepted',
  Faulted: 'Faulted',
  Occupied: 'Occupied',
  Rejected: 'Rejected',
  Unavailable: 'Unavailable',
} as const;

export type ReserveNowStatusEnum = (typeof ReserveNowStatusEnum)[keyof typeof ReserveNowStatusEnum];
