import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateSigningUseEnum } from '../../enums/CertificateSigningUseEnum.js';

export interface CertificateSignedRequest {
  certificateChain: string;
  certificateType?: CertificateSigningUseEnum;
  requestId?: number;
  customData?: CustomDataType;
}
