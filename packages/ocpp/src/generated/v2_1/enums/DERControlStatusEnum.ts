export const DERControlStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NotSupported: 'NotSupported',
  NotFound: 'NotFound',
} as const;

export type DERControlStatusEnum = (typeof DERControlStatusEnum)[keyof typeof DERControlStatusEnum];
