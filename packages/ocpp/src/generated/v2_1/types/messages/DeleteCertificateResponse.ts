import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { DeleteCertificateStatusEnum } from '../../enums/DeleteCertificateStatusEnum.js';

export interface DeleteCertificateResponse {
  status: DeleteCertificateStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
