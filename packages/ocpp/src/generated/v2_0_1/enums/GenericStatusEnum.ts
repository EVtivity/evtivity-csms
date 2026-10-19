export const GenericStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type GenericStatusEnum = (typeof GenericStatusEnum)[keyof typeof GenericStatusEnum];
