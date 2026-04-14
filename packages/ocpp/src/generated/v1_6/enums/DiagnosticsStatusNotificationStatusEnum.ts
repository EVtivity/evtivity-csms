export const DiagnosticsStatusNotificationStatusEnum = {
  Idle: 'Idle',
  Uploaded: 'Uploaded',
  UploadFailed: 'UploadFailed',
  Uploading: 'Uploading',
} as const;

export type DiagnosticsStatusNotificationStatusEnum = (typeof DiagnosticsStatusNotificationStatusEnum)[keyof typeof DiagnosticsStatusNotificationStatusEnum];
