export const UnlockConnectorStatusEnum = {
  Unlocked: 'Unlocked',
  UnlockFailed: 'UnlockFailed',
  NotSupported: 'NotSupported',
} as const;

export type UnlockConnectorStatusEnum = (typeof UnlockConnectorStatusEnum)[keyof typeof UnlockConnectorStatusEnum];
