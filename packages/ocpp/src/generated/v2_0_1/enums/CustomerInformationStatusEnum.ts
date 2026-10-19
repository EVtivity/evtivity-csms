export const CustomerInformationStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Invalid: 'Invalid',
} as const;

export type CustomerInformationStatusEnum = (typeof CustomerInformationStatusEnum)[keyof typeof CustomerInformationStatusEnum];
