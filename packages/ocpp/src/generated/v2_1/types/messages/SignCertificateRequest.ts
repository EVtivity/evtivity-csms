import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateSigningUseEnum } from '../../enums/CertificateSigningUseEnum.js';

export interface SignCertificateRequest {
  csr: string;
  certificateType?: CertificateSigningUseEnum;
  hashRootCertificate?: CertificateHashDataType;
  requestId?: number;
  customData?: CustomDataType;
}
