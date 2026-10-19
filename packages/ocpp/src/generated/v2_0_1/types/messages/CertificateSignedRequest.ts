import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateSigningUseEnum } from '../../enums/CertificateSigningUseEnum.js';

export interface CertificateSignedRequest {
  customData?: CustomDataType;
  certificateChain: string;
  certificateType?: CertificateSigningUseEnum;
}
