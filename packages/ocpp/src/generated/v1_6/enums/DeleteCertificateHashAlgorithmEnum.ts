export const DeleteCertificateHashAlgorithmEnum = {
  SHA256: 'SHA256',
  SHA384: 'SHA384',
  SHA512: 'SHA512',
} as const;

export type DeleteCertificateHashAlgorithmEnum = (typeof DeleteCertificateHashAlgorithmEnum)[keyof typeof DeleteCertificateHashAlgorithmEnum];
