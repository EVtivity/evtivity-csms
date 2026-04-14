export const UpdateFirmwareStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  AcceptedCanceled: 'AcceptedCanceled',
  InvalidCertificate: 'InvalidCertificate',
  RevokedCertificate: 'RevokedCertificate',
} as const;

export type UpdateFirmwareStatusEnum = (typeof UpdateFirmwareStatusEnum)[keyof typeof UpdateFirmwareStatusEnum];
