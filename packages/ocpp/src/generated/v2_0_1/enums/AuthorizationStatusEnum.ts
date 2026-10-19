export const AuthorizationStatusEnum = {
  Accepted: 'Accepted',
  Blocked: 'Blocked',
  ConcurrentTx: 'ConcurrentTx',
  Expired: 'Expired',
  Invalid: 'Invalid',
  NoCredit: 'NoCredit',
  NotAllowedTypeEVSE: 'NotAllowedTypeEVSE',
  NotAtThisLocation: 'NotAtThisLocation',
  NotAtThisTime: 'NotAtThisTime',
  Unknown: 'Unknown',
} as const;

export type AuthorizationStatusEnum = (typeof AuthorizationStatusEnum)[keyof typeof AuthorizationStatusEnum];
