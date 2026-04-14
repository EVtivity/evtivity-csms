import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { DERControlStatusEnum } from '../../enums/DERControlStatusEnum.js';

export interface GetDERControlResponse {
  status: DERControlStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
