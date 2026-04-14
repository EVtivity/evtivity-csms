import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateStatusSourceEnum } from '../../enums/CertificateStatusSourceEnum.js';

export interface CertificateStatusRequestInfoType {
  certificateHashData: CertificateHashDataType;
  source: CertificateStatusSourceEnum;
  urls: string[];
  customData?: CustomDataType;
}

export interface GetCertificateChainStatusRequest {
  certificateStatusRequests: CertificateStatusRequestInfoType[];
  customData?: CustomDataType;
}
