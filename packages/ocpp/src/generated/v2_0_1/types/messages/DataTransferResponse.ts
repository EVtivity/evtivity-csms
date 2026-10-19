import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { DataTransferStatusEnum } from '../../enums/DataTransferStatusEnum.js';

export interface DataTransferResponse {
  customData?: CustomDataType;
  status: DataTransferStatusEnum;
  statusInfo?: StatusInfoType;
  data?: string;
}
