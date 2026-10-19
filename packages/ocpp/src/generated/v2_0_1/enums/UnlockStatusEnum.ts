export const UnlockStatusEnum = {
  Unlocked: 'Unlocked',
  UnlockFailed: 'UnlockFailed',
  OngoingAuthorizedTransaction: 'OngoingAuthorizedTransaction',
  UnknownConnector: 'UnknownConnector',
} as const;

export type UnlockStatusEnum = (typeof UnlockStatusEnum)[keyof typeof UnlockStatusEnum];
