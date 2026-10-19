export const UnpublishFirmwareStatusEnum = {
  DownloadOngoing: 'DownloadOngoing',
  NoFirmware: 'NoFirmware',
  Unpublished: 'Unpublished',
} as const;

export type UnpublishFirmwareStatusEnum = (typeof UnpublishFirmwareStatusEnum)[keyof typeof UnpublishFirmwareStatusEnum];
