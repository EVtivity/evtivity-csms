export const SignedUpdateFirmwareStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  AcceptedCanceled: 'AcceptedCanceled',
  InvalidCertificate: 'InvalidCertificate',
  RevokedCertificate: 'RevokedCertificate',
} as const;

export type SignedUpdateFirmwareStatusEnum = (typeof SignedUpdateFirmwareStatusEnum)[keyof typeof SignedUpdateFirmwareStatusEnum];
