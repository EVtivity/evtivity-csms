export const SendLocalListStatusEnum = {
  Accepted: 'Accepted',
  Blocked: 'Blocked',
  Expired: 'Expired',
  Invalid: 'Invalid',
  ConcurrentTx: 'ConcurrentTx',
} as const;

export type SendLocalListStatusEnum = (typeof SendLocalListStatusEnum)[keyof typeof SendLocalListStatusEnum];
