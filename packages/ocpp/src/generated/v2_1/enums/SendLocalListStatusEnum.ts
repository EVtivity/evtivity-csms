export const SendLocalListStatusEnum = {
  Accepted: 'Accepted',
  Failed: 'Failed',
  VersionMismatch: 'VersionMismatch',
} as const;

export type SendLocalListStatusEnum = (typeof SendLocalListStatusEnum)[keyof typeof SendLocalListStatusEnum];
