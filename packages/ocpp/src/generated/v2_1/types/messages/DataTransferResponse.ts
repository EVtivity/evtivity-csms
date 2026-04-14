import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { DataTransferStatusEnum } from '../../enums/DataTransferStatusEnum.js';

export interface DataTransferResponse {
  status: DataTransferStatusEnum;
  statusInfo?: StatusInfoType;
  data?: string;
  customData?: CustomDataType;
}
