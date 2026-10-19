export const DeleteCertificateStatusEnum = {
  Accepted: 'Accepted',
  Failed: 'Failed',
  NotFound: 'NotFound',
} as const;

export type DeleteCertificateStatusEnum = (typeof DeleteCertificateStatusEnum)[keyof typeof DeleteCertificateStatusEnum];
