export const AuthorizeCertificateStatusEnum = {
  Accepted: 'Accepted',
  SignatureError: 'SignatureError',
  CertificateExpired: 'CertificateExpired',
  CertificateRevoked: 'CertificateRevoked',
  NoCertificateAvailable: 'NoCertificateAvailable',
  CertChainError: 'CertChainError',
  ContractCancelled: 'ContractCancelled',
} as const;

export type AuthorizeCertificateStatusEnum = (typeof AuthorizeCertificateStatusEnum)[keyof typeof AuthorizeCertificateStatusEnum];
