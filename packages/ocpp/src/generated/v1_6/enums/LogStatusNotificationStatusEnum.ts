export const LogStatusNotificationStatusEnum = {
  BadMessage: 'BadMessage',
  Idle: 'Idle',
  NotSupportedOperation: 'NotSupportedOperation',
  PermissionDenied: 'PermissionDenied',
  Uploaded: 'Uploaded',
  UploadFailure: 'UploadFailure',
  Uploading: 'Uploading',
} as const;

export type LogStatusNotificationStatusEnum = (typeof LogStatusNotificationStatusEnum)[keyof typeof LogStatusNotificationStatusEnum];
