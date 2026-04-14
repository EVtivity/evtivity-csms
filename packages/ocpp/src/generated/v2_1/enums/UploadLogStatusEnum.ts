export const UploadLogStatusEnum = {
  BadMessage: 'BadMessage',
  Idle: 'Idle',
  NotSupportedOperation: 'NotSupportedOperation',
  PermissionDenied: 'PermissionDenied',
  Uploaded: 'Uploaded',
  UploadFailure: 'UploadFailure',
  Uploading: 'Uploading',
  AcceptedCanceled: 'AcceptedCanceled',
} as const;

export type UploadLogStatusEnum = (typeof UploadLogStatusEnum)[keyof typeof UploadLogStatusEnum];
