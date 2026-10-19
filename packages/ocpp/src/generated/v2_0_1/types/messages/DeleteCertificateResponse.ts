import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { DeleteCertificateStatusEnum } from '../../enums/DeleteCertificateStatusEnum.js';

export interface DeleteCertificateResponse {
  customData?: CustomDataType;
  status: DeleteCertificateStatusEnum;
  statusInfo?: StatusInfoType;
}
