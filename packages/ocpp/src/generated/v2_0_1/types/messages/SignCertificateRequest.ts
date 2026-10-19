import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateSigningUseEnum } from '../../enums/CertificateSigningUseEnum.js';

export interface SignCertificateRequest {
  customData?: CustomDataType;
  csr: string;
  certificateType?: CertificateSigningUseEnum;
}
