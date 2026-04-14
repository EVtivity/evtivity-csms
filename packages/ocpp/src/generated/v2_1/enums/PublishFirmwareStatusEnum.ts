export const PublishFirmwareStatusEnum = {
  Idle: 'Idle',
  DownloadScheduled: 'DownloadScheduled',
  Downloading: 'Downloading',
  Downloaded: 'Downloaded',
  Published: 'Published',
  DownloadFailed: 'DownloadFailed',
  DownloadPaused: 'DownloadPaused',
  InvalidChecksum: 'InvalidChecksum',
  ChecksumVerified: 'ChecksumVerified',
  PublishFailed: 'PublishFailed',
} as const;

export type PublishFirmwareStatusEnum = (typeof PublishFirmwareStatusEnum)[keyof typeof PublishFirmwareStatusEnum];
