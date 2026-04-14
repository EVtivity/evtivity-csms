export const FirmwareStatusNotificationStatusEnum = {
  Downloaded: 'Downloaded',
  DownloadFailed: 'DownloadFailed',
  Downloading: 'Downloading',
  Idle: 'Idle',
  InstallationFailed: 'InstallationFailed',
  Installing: 'Installing',
  Installed: 'Installed',
} as const;

export type FirmwareStatusNotificationStatusEnum = (typeof FirmwareStatusNotificationStatusEnum)[keyof typeof FirmwareStatusNotificationStatusEnum];
