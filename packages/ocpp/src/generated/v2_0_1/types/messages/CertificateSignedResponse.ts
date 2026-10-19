import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { CertificateSignedStatusEnum } from '../../enums/CertificateSignedStatusEnum.js';

export interface CertificateSignedResponse {
  customData?: CustomDataType;
  status: CertificateSignedStatusEnum;
  statusInfo?: StatusInfoType;
}
