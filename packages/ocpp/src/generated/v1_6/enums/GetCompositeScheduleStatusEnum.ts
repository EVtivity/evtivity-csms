export const GetCompositeScheduleStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type GetCompositeScheduleStatusEnum = (typeof GetCompositeScheduleStatusEnum)[keyof typeof GetCompositeScheduleStatusEnum];
