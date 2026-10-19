export const CertificateSigningUseEnum = {
  ChargingStationCertificate: 'ChargingStationCertificate',
  V2GCertificate: 'V2GCertificate',
} as const;

export type CertificateSigningUseEnum = (typeof CertificateSigningUseEnum)[keyof typeof CertificateSigningUseEnum];
