import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { Iso15118EVCertificateStatusEnum } from '../../enums/Iso15118EVCertificateStatusEnum.js';

export interface Get15118EVCertificateResponse {
  customData?: CustomDataType;
  status: Iso15118EVCertificateStatusEnum;
  statusInfo?: StatusInfoType;
  exiResponse: string;
}
