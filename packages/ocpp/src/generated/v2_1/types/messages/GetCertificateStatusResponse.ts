import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GetCertificateStatusEnum } from '../../enums/GetCertificateStatusEnum.js';

export interface GetCertificateStatusResponse {
  status: GetCertificateStatusEnum;
  statusInfo?: StatusInfoType;
  ocspResult?: string;
  customData?: CustomDataType;
}
