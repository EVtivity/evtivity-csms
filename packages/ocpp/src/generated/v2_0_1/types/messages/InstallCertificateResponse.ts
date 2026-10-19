import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { InstallCertificateStatusEnum } from '../../enums/InstallCertificateStatusEnum.js';

export interface InstallCertificateResponse {
  customData?: CustomDataType;
  status: InstallCertificateStatusEnum;
  statusInfo?: StatusInfoType;
}
