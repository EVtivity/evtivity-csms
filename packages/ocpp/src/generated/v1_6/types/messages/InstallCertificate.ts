import type { InstallCertificateCertificateTypeEnum } from '../../enums/InstallCertificateCertificateTypeEnum.js';

export interface InstallCertificate {
  certificateType: InstallCertificateCertificateTypeEnum;
  certificate: string;
}
