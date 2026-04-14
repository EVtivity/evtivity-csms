export const SignedFirmwareStatusNotificationStatusEnum = {
  Downloaded: 'Downloaded',
  DownloadFailed: 'DownloadFailed',
  Downloading: 'Downloading',
  DownloadScheduled: 'DownloadScheduled',
  DownloadPaused: 'DownloadPaused',
  Idle: 'Idle',
  InstallationFailed: 'InstallationFailed',
  Installing: 'Installing',
  Installed: 'Installed',
  InstallRebooting: 'InstallRebooting',
  InstallScheduled: 'InstallScheduled',
  InstallVerificationFailed: 'InstallVerificationFailed',
  InvalidSignature: 'InvalidSignature',
  SignatureVerified: 'SignatureVerified',
} as const;

export type SignedFirmwareStatusNotificationStatusEnum = (typeof SignedFirmwareStatusNotificationStatusEnum)[keyof typeof SignedFirmwareStatusNotificationStatusEnum];
