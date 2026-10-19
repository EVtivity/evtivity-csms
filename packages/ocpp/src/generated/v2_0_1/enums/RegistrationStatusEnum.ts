export const RegistrationStatusEnum = {
  Accepted: 'Accepted',
  Pending: 'Pending',
  Rejected: 'Rejected',
} as const;

export type RegistrationStatusEnum = (typeof RegistrationStatusEnum)[keyof typeof RegistrationStatusEnum];
