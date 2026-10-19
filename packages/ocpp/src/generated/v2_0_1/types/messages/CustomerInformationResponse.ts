import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { CustomerInformationStatusEnum } from '../../enums/CustomerInformationStatusEnum.js';

export interface CustomerInformationResponse {
  customData?: CustomDataType;
  status: CustomerInformationStatusEnum;
  statusInfo?: StatusInfoType;
}
