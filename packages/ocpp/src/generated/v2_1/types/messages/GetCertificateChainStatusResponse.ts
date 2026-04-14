import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateStatusEnum } from '../../enums/CertificateStatusEnum.js';
import type { CertificateStatusSourceEnum } from '../../enums/CertificateStatusSourceEnum.js';

export interface CertificateStatusType {
  certificateHashData: CertificateHashDataType;
  source: CertificateStatusSourceEnum;
  status: CertificateStatusEnum;
  nextUpdate: string;
  customData?: CustomDataType;
}

export interface GetCertificateChainStatusResponse {
  certificateStatus: CertificateStatusType[];
  customData?: CustomDataType;
}
